# Zen Tidy Tabs Codex

A Zen Browser mod in the same style as [`Vertex-Mods/Zen-Tidy-Tabs`](https://github.com/Vertex-Mods/Zen-Tidy-Tabs): it injects a broom button into Zen's pinned-tabs separator, classifies ungrouped tabs with Codex CLI/local AI/OpenAI-compatible APIs/heuristics, creates native Zen tab groups, and moves matching tabs into those groups.

This is **not** a normal WebExtension. It is a Zen/Sine/ATG-style chrome mod with:

- `theme.json` mod manifest
- `tidy-tabs.uc.js` privileged browser chrome script
- `tidy-downloads.uc.js` plus vendored `modules/tidy-downloads/` and `modules/zen-stuff/` from [`Vertex-Mods/Zen-Tidy-Downloads`](https://github.com/Vertex-Mods/Zen-Tidy-Downloads)
- `userChrome.css` button/animation styling, including vendored Tidy Downloads chrome styles
- `preferences.json` Zen mod preferences

## Providers

Set `zen-tidy-tabs.provider` in the mod preferences:

- `local` — Firefox/Zen local AI using `Mozilla/smart-tab-embedding` and `Mozilla/smart-tab-topic`.
- `codex` — runs an installed, already-authenticated Codex CLI locally via privileged Zen chrome `Subprocess`.
- `openai` — OpenAI-compatible `/v1/chat/completions` endpoint.
- `heuristic` — no AI/API; groups by host/title rules.

Codex prefs:

- `zen-tidy-tabs.codex.path`, default `/opt/homebrew/bin/codex`
- `zen-tidy-tabs.codex.model`, optional model override
- `zen-tidy-tabs.codex.timeoutSeconds`, default `90`

Codex mode assumes `codex` is installed and already logged in on the same machine/profile user. The tab-tidying feature and the vendored Tidy Downloads AI rename flow both use the same Codex prefs when `zen-tidy-tabs.provider` is `codex`. It invokes:

```text
codex exec --skip-git-repo-check --sandbox read-only --color never --ephemeral -
```

For debugging, the mod writes these prefs after each tidy attempt:

```text
zen-tidy-tabs.debug.lastProviderRequested
zen-tidy-tabs.debug.lastProvider
zen-tidy-tabs.debug.lastCodexStatus
```

`lastCodexStatus` starts with `starting`, `success`, `failed`, `exception`, or `empty`.

Tidy Downloads Codex rename status is stored separately in:

```text
zen-tidy-tabs.debug.downloads.lastStatus
```

OpenAI-compatible prefs:

- `zen-tidy-tabs.openai.baseUrl`, default `https://api.openai.com/v1`
- `zen-tidy-tabs.openai.model`, default `gpt-4.1-mini`
- `zen-tidy-tabs.openai.apiKey`
- `zen-tidy-tabs.openai.sendPaths`, default `false`

## Codex subscription note

A ChatGPT/Codex subscription is not an API credential for `/v1` API calls. This mod can, however, use your locally installed and authenticated Codex CLI by spawning it on your machine. If Codex CLI is not installed/logged in or Zen blocks subprocess execution in your setup, use an OpenAI API key, another OpenAI-compatible provider, Firefox local AI, or heuristic mode.

## Install / dev

Install like other Zen chrome mods / Sine / ATG mods by loading this folder or copying:

- `theme.json`
- `tidy-tabs.uc.js`
- `userChrome.css`
- `preferences.json`

Because this mod uses a privileged `.uc.js` script, Sine must allow JS mods:

```text
sine.allow-unsafe-js = true
```

Advanced Tab Groups is recommended because this mod calls Zen/Firefox chrome tab-group APIs and uses optional ATG color helpers when available.

## Behavior

Tabs:

- Only acts on the active Zen workspace.
- Skips pinned, selected, empty, glance, and already-grouped tabs.
- Shows the broom button when there are enough ungrouped tabs, or when groups already exist and there is at least one ungrouped tab.
- Uses native `gBrowser.addTabGroup()` and `gBrowser.moveTabToExistingGroup()` rather than WebExtension tab groups.

Downloads:

- Vendors the Zen Tidy Downloads UI/pod/tooltip/download listener behavior.
- Keeps upstream Mistral preferences for users who want that provider.
- Download AI rename suggestions use `zen-tidy-tabs.downloads.provider`, default `codex`. `codex` uses the installed Codex CLI; `mistral` uses the upstream Mistral API prefs.
- For text-like downloads (`.txt`, `.md`, `.csv`, `.json`, source code, logs, HTML/XML/YAML, etc.), reads a bounded content preview and asks the model to name the file primarily from the actual contents, mimicking Arc's content-aware tidy downloads behavior.
- `zen-tidy-tabs.downloads.contentMaxBytes` controls the maximum text bytes included in the rename prompt, default `12000`.
- Debug prefs under `zen-tidy-tabs.debug.downloads.*` record bootstrap/module readiness, enqueue attempts, provider, content preview status, and final rename status.

## Safety / privacy

Local and heuristic modes do not send tab data to a remote API. OpenAI-compatible and Codex CLI modes send tab title, hostname, and optionally URL path with query/hash removed to the selected model/provider. Do not publish a personal API key in this repository.
