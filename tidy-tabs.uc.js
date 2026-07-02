// ==UserScript==
// @ignorecache
// @name        Zen Tidy Tabs OpenAI
// @description Arc-like tidy tabs for Zen using Firefox local AI, OpenAI-compatible APIs, or heuristics.
// ==/UserScript==

(() => {
  const CONFIG = {
    MIN_TABS_FOR_SORT: 4,
    SIMILARITY_THRESHOLD: 0.45,
    INIT_RETRIES: 60,
    INIT_INTERVAL_MS: 150,
    COLORS_DELAY_MS: 500,
    PREF_PROVIDER: "zen-tidy-tabs.provider",
    PREF_BASE_URL: "zen-tidy-tabs.openai.baseUrl",
    PREF_MODEL: "zen-tidy-tabs.openai.model",
    PREF_API_KEY: "zen-tidy-tabs.openai.apiKey",
    PREF_SEND_PATHS: "zen-tidy-tabs.openai.sendPaths",
    PREF_CODEX_PATH: "zen-tidy-tabs.codex.path",
    PREF_CODEX_MODEL: "zen-tidy-tabs.codex.model",
    PREF_CODEX_TIMEOUT: "zen-tidy-tabs.codex.timeoutSeconds"
  };

  let isTidying = false;
  let listenerInstalled = false;

  const log = (...args) => console.log("[ZenTidyTabs]", ...args);
  const warn = (...args) => console.warn("[ZenTidyTabs]", ...args);
  const error = (...args) => console.error("[ZenTidyTabs]", ...args);

  function pref(name, fallback = "") {
    try {
      const branch = Services.prefs;
      switch (branch.getPrefType(name)) {
        case branch.PREF_BOOL: return branch.getBoolPref(name, Boolean(fallback));
        case branch.PREF_INT: return branch.getIntPref(name, Number(fallback) || 0);
        case branch.PREF_STRING: return branch.getStringPref(name, String(fallback));
        default: return fallback;
      }
    } catch {
      return fallback;
    }
  }

  function activeWorkspaceId() {
    return window.gZenWorkspaces?.activeWorkspace;
  }

  function activeWorkspaceElement() {
    return window.gZenWorkspaces?.activeWorkspaceElement || document;
  }

  function tabTitle(tab) {
    const label = tab?.getAttribute?.("label") || tab?.querySelector?.(".tab-label,.tab-text")?.textContent || "";
    if (label && !/^https?:|^about:blank$|^Loading/i.test(label)) return label.trim();
    try {
      const url = gBrowser.getBrowserForTab(tab)?.currentURI?.spec;
      return new URL(url).hostname.replace(/^www\./, "") || "Untitled";
    } catch {
      return "Untitled";
    }
  }

  function tabUrl(tab) {
    try { return gBrowser.getBrowserForTab(tab)?.currentURI?.spec || ""; }
    catch { return ""; }
  }

  function tabHost(tab) {
    try { return new URL(tabUrl(tab)).hostname.replace(/^www\./, ""); }
    catch { return ""; }
  }

  function eligibleTabs({ includeGrouped = false } = {}) {
    const workspaceId = activeWorkspaceId();
    if (!workspaceId || !gBrowser?.tabs) return [];
    return Array.from(gBrowser.tabs).filter((tab) => {
      if (!tab?.isConnected) return false;
      if (tab.getAttribute("zen-workspace-id") !== workspaceId) return false;
      if (tab.pinned || tab.selected) return false;
      if (tab.hasAttribute("zen-empty-tab") || tab.hasAttribute("zen-glance-tab")) return false;
      if (!includeGrouped && tab.closest("tab-group")) return false;
      return true;
    });
  }

  function existingGroups() {
    const workspaceId = activeWorkspaceId();
    const groups = new Map();
    if (!workspaceId) return groups;
    document.querySelectorAll(`tab-group[zen-workspace-id="${CSS.escape(workspaceId)}"], tab-group:has(tab[zen-workspace-id="${CSS.escape(workspaceId)}"])`).forEach((el) => {
      const label = el.getAttribute("label");
      if (label) groups.set(label, el);
    });
    return groups;
  }

  function groupBy(items, keyFn) {
    const out = new Map();
    for (const item of items) {
      const key = keyFn(item) || "Other";
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(item);
    }
    return out;
  }

  function heuristicName(tab) {
    const host = tabHost(tab);
    const text = `${tabTitle(tab)} ${host}`.toLowerCase();
    if (/github|gitlab|pull request|commit|repo/.test(text)) return "Code";
    if (/developer\.mozilla|docs|api|reference|guide|manual/.test(text)) return "Docs";
    if (/openai|anthropic|gemini|claude|perplexity|chatgpt/.test(text)) return "AI";
    if (/youtube|twitch|netflix|video/.test(text)) return "Media";
    if (/mail|gmail|outlook/.test(text)) return "Mail";
    if (/amazon|ebay|cart|checkout|shop/.test(text)) return "Shopping";
    const parts = host.split(".");
    return (parts.length > 1 ? parts.at(-2) : host || "Other").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 24);
  }

  function heuristicPlan(tabs) {
    return [...groupBy(tabs, heuristicName).entries()]
      .filter(([, groupTabs]) => groupTabs.length > 1)
      .map(([topic, groupTabs]) => ({ topic, tabs: groupTabs }));
  }

  function average(vectors) {
    if (!vectors.length) return [];
    const len = vectors[0].length;
    const out = Array(len).fill(0);
    for (const vector of vectors) for (let i = 0; i < len; i++) out[i] += vector[i];
    return out.map((value) => value / vectors.length);
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  async function localEmbedding(title) {
    const { createEngine } = ChromeUtils.importESModule("chrome://global/content/ml/EngineProcess.sys.mjs");
    const engine = await createEngine({ taskName: "feature-extraction", modelId: "Mozilla/smart-tab-embedding", modelHub: "huggingface", engineId: "zen-tidy-tabs-embedding" });
    const result = await engine.run({ args: [title] });
    const raw = result?.[0]?.embedding || result?.[0] || result;
    const vector = Array.isArray(raw?.[0]) ? average(raw) : raw;
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
    return vector.map((v) => v / norm);
  }

  async function localTopic(titles) {
    try {
      const { createEngine } = ChromeUtils.importESModule("chrome://global/content/ml/EngineProcess.sys.mjs");
      const engine = await createEngine({ taskName: "text2text-generation", modelId: "Mozilla/smart-tab-topic", modelHub: "huggingface", engineId: "zen-tidy-tabs-topic" });
      const result = await engine.run({ args: [`Name this browser tab group in 1-3 words:\n${titles.join("\n")}`], options: { max_new_tokens: 8, temperature: 0.4 } });
      return String(result?.[0]?.generated_text || "Group").split("\n")[0].trim().replace(/^['"`]+|['"`]+$/g, "").slice(0, 24) || "Group";
    } catch (e) {
      warn("Local topic model failed", e);
      return heuristicName({ getAttribute: () => titles[0] });
    }
  }

  async function localAiPlan(tabs) {
    const vectors = [];
    for (const tab of tabs) vectors.push(await localEmbedding(tabTitle(tab)));
    const used = new Set();
    const groups = [];
    for (let i = 0; i < tabs.length; i++) {
      if (used.has(i)) continue;
      const indices = [i];
      used.add(i);
      for (let j = i + 1; j < tabs.length; j++) {
        if (!used.has(j) && cosine(vectors[i], vectors[j]) >= CONFIG.SIMILARITY_THRESHOLD) {
          indices.push(j); used.add(j);
        }
      }
      if (indices.length > 1) {
        const groupTabs = indices.map((idx) => tabs[idx]);
        groups.push({ topic: await localTopic(groupTabs.map(tabTitle)), tabs: groupTabs });
      }
    }
    return groups;
  }

  function remoteTabPayload(tab) {
    let url = "";
    try {
      const parsed = new URL(tabUrl(tab));
      parsed.hash = "";
      parsed.search = "";
      url = pref(CONFIG.PREF_SEND_PATHS, false) ? parsed.toString() : parsed.hostname;
    } catch {}
    return { id: tab._tPos ?? tab.getAttribute("tabindex") ?? tabTitle(tab), title: tabTitle(tab), host: tabHost(tab), url };
  }

  function parseJsonPlan(text, tabs) {
    const raw = String(text || "").trim();
    const jsonText = raw.startsWith("{") ? raw : raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const json = JSON.parse(jsonText);
    return (json.groups || []).map((group) => ({
      topic: String(group.topic || "Group").replace(/^['"`]+|['"`]+$/g, "").slice(0, 24),
      tabs: [...new Set(group.indexes || [])].map((idx) => tabs[idx]).filter(Boolean)
    })).filter((group) => group.topic && group.tabs.length > 1);
  }

  function groupingPrompt(payload) {
    return `Group these browser tabs like Arc Tidy Tabs. Create concise 1-3 word group names. Only use indexes provided. Omit single-tab groups unless they clearly match another tab. Return strict JSON only with this exact schema: {"groups":[{"topic":"Docs","indexes":[0,1]}]}\nTabs: ${JSON.stringify(payload)}`;
  }

  async function openAiPlan(tabs) {
    const baseUrl = String(pref(CONFIG.PREF_BASE_URL, "https://api.openai.com/v1")).replace(/\/+$/, "");
    const model = pref(CONFIG.PREF_MODEL, "gpt-4.1-mini");
    const apiKey = pref(CONFIG.PREF_API_KEY, "");
    if (!apiKey) throw new Error("Missing zen-tidy-tabs.openai.apiKey preference");
    const payload = tabs.map((tab, index) => ({ ...remoteTabPayload(tab), index }));
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return strict JSON only." },
          { role: "user", content: groupingPrompt(payload) }
        ]
      })
    });
    if (!response.ok) throw new Error(`OpenAI-compatible request failed: ${response.status} ${await response.text()}`);
    return parseJsonPlan((await response.json())?.choices?.[0]?.message?.content, tabs);
  }

  async function runSubprocess(command, args, stdin, timeoutSeconds) {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({ command, arguments: args, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    await proc.stdin.write(stdin);
    await proc.stdin.close();
    let timedOut = false;
    const timeout = new Promise((_, reject) => setTimeout(() => { timedOut = true; try { proc.kill(); } catch {} reject(new Error(`Codex CLI timed out after ${timeoutSeconds}s`)); }, timeoutSeconds * 1000));
    const done = Promise.all([proc.stdout.readString(), proc.stderr.readString(), proc.wait()]);
    const [stdout, stderr, result] = await Promise.race([done, timeout]);
    if (!timedOut && result.exitCode !== 0) throw new Error(`Codex CLI failed (${result.exitCode}): ${stderr || stdout}`);
    return stdout;
  }

  async function codexPlan(tabs) {
    const codexPath = pref(CONFIG.PREF_CODEX_PATH, "/opt/homebrew/bin/codex");
    const model = pref(CONFIG.PREF_CODEX_MODEL, "");
    const timeoutSeconds = Math.max(15, Number(pref(CONFIG.PREF_CODEX_TIMEOUT, 90)) || 90);
    const payload = tabs.map((tab, index) => ({ ...remoteTabPayload(tab), index }));
    const args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--ephemeral"];
    if (model) args.push("--model", model);
    args.push("-");
    const prompt = `${groupingPrompt(payload)}\n\nImportant: Output only the JSON object. Do not inspect files, run commands, or include markdown.`;
    return parseJsonPlan(await runSubprocess(codexPath, args, prompt, timeoutSeconds), tabs);
  }

  async function buildPlan(tabs) {
    const provider = pref(CONFIG.PREF_PROVIDER, "local");
    if (provider === "codex") return codexPlan(tabs);
    if (provider === "openai") return openAiPlan(tabs);
    if (provider === "heuristic") return heuristicPlan(tabs);
    try { return await localAiPlan(tabs); }
    catch (e) { warn("Local AI failed; falling back to heuristics", e); return heuristicPlan(tabs); }
  }

  function findOrCreateGroup(topic, tabs, groupMap) {
    const existing = groupMap.get(topic);
    if (existing?.isConnected) return existing;
    const group = gBrowser.addTabGroup(tabs, { label: topic, insertBefore: tabs[0] });
    if (group?._useFaviconColor) setTimeout(() => group._useFaviconColor(), CONFIG.COLORS_DELAY_MS);
    groupMap.set(topic, group);
    return group;
  }

  async function tidyTabs() {
    if (isTidying) return;
    isTidying = true;
    document.querySelectorAll(".pinned-tabs-container-separator").forEach((el) => el.classList.add("separator-is-sorting"));
    try {
      const tabs = eligibleTabs();
      if (tabs.length < 2) return;
      tabs.forEach((tab) => tab.classList.add("tab-is-sorting"));
      const plan = await buildPlan(tabs);
      const groupMap = existingGroups();
      for (const group of plan) {
        const liveTabs = group.tabs.filter((tab) => tab?.isConnected && !tab.closest("tab-group"));
        if (!liveTabs.length) continue;
        const groupEl = findOrCreateGroup(group.topic, liveTabs, groupMap);
        for (const tab of liveTabs) {
          if (!tab.closest("tab-group") && groupEl?.isConnected) gBrowser.moveTabToExistingGroup(tab, groupEl);
        }
      }
      log(`Tidied ${tabs.length} tabs into ${plan.length} groups`);
    } catch (e) {
      error("Tidy failed", e);
    } finally {
      eligibleTabs({ includeGrouped: true }).forEach((tab) => tab.classList.remove("tab-is-sorting"));
      document.querySelectorAll(".pinned-tabs-container-separator").forEach((el) => el.classList.remove("separator-is-sorting"));
      isTidying = false;
      updateVisibility();
    }
  }

  function ensureButton(separator) {
    if (!separator || separator.querySelector("#sort-button")) return;
    if (!separator.querySelector("svg.separator-line-svg")) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "separator-line-svg");
      svg.setAttribute("viewBox", "0 0 100 2");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("id", "separator-path");
      path.setAttribute("class", "separator-path-segment");
      path.setAttribute("d", "M 0 1 L 100 1");
      path.style.fill = "none";
      svg.appendChild(path);
      separator.prepend(svg);
    }
    const fragment = MozXULElement.parseXULToFragment(`<toolbarbutton id="sort-button" class="sort-button-with-icon" command="cmd_zenSortTabs" tooltiptext="Tidy tabs into groups"><hbox class="toolbarbutton-box" align="center"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 28 28" class="broom-icon"><path d="M19.9 21.4c0-.4-.3-.7-.6-.8L7.2 16.8c-.3-.1-.7 0-.9.3-.5.7-1.6 1.9-2.5 2.9-1.4 1.4-.8 2.5.9 3 .2.1 1.1-1.3 1.5-1.3.3.1.7 1.9 1.1 2.1l10.6 3.3c1.7.5 2.7-.1 2.4-2-.2-1.3-.3-2.9-.4-3.7ZM16.7 1.7c.8-2.5 4.1-1.4 3.3 1l-4.1 13.3 3.3 1c1.7.5 1 3-0.8 2.4l-9.9-3.1c-1.7-.5-.9-2.9.8-2.4l3.3 1 4.1-13.2Z"/></svg></hbox></toolbarbutton>`);
    const clear = separator.querySelector(".zen-workspace-close-unpinned-tabs-button");
    separator.insertBefore(fragment.firstChild, clear || null);
  }

  function installCommand() {
    const commandSet = document.querySelector("commandset#zenCommandSet");
    if (!commandSet) return false;
    if (!commandSet.querySelector("#cmd_zenSortTabs")) commandSet.appendChild(MozXULElement.parseXULToFragment(`<command id="cmd_zenSortTabs"/>`).firstChild);
    if (!listenerInstalled) {
      commandSet.addEventListener("command", (event) => {
        if (event.target.id === "cmd_zenSortTabs") {
          activeWorkspaceElement().querySelector("#sort-button")?.classList.add("brushing");
          setTimeout(() => document.querySelectorAll("#sort-button.brushing").forEach((b) => b.classList.remove("brushing")), 850);
          tidyTabs();
        }
      });
      listenerInstalled = true;
    }
    return true;
  }

  function updateVisibility() {
    const count = eligibleTabs().length;
    const hasGroups = existingGroups().size > 0;
    document.querySelectorAll(".pinned-tabs-container-separator").forEach((separator) => {
      ensureButton(separator);
      separator.querySelector("#sort-button")?.classList.toggle("hidden-button", !(hasGroups ? count > 0 : count >= CONFIG.MIN_TABS_FOR_SORT));
    });
  }

  function initialize() {
    if (!gBrowser?.tabContainer || !window.gZenWorkspaces || !installCommand()) return false;
    document.querySelectorAll(".pinned-tabs-container-separator").forEach(ensureButton);
    updateVisibility();
    ["TabOpen", "TabClose", "TabSelect", "TabPinned", "TabUnpinned", "TabGrouped", "TabUngrouped", "TabAttrModified"].forEach((name) => gBrowser.tabContainer.addEventListener(name, () => setTimeout(updateVisibility, 100)));
    window.addEventListener("zen-workspace-switched", () => setTimeout(updateVisibility, 100));
    const originalUpdate = window.gZenWorkspaces.updateTabsContainers;
    if (typeof originalUpdate === "function" && !originalUpdate.__zenTidyTabsPatched) {
      window.gZenWorkspaces.updateTabsContainers = function (...args) {
        const result = originalUpdate.apply(this, args);
        setTimeout(updateVisibility, 100);
        return result;
      };
      window.gZenWorkspaces.updateTabsContainers.__zenTidyTabsPatched = true;
    }
    log("initialized");
    return true;
  }

  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (initialize() || tries >= CONFIG.INIT_RETRIES) clearInterval(timer);
  }, CONFIG.INIT_INTERVAL_MS);
})();
