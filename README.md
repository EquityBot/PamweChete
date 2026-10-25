# PamweChete

Ryan Duguid's personal [pi](https://github.com/earendil-works/pi) configuration, derived from Amos Blomqvist's [pi-config](https://github.com/amosblomqvist/pi-config) and extended from there.

Clone: `https://github.com/ryanduguid/PamweChete.git`

This is not meant to be installed as one big package. Browse the repo and copy the pieces you want into your own Pi config.

## Upstream and licensing

Most of the extensions and skills here, and the shape of this README, started as Amos Blomqvist's [pi-config](https://github.com/amosblomqvist/pi-config). That work remains his. He walks through the original setup in [My Pi Setup After 6 Months](https://www.youtube.com/@EeroAlvar) and its predecessor [Pi Coding Agent Setup After 2 Months](https://www.youtube.com/watch?v=DWWrLlM3gwQ), on the channel that `assets/thumbnail.png` links to.

[![video](assets/thumbnail.png)](https://www.youtube.com/@EeroAlvar)
[![Verify](https://github.com/ryanduguid/PamweChete/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/ryanduguid/PamweChete/actions/workflows/verify.yml)

`amosblomqvist/pi-config` publishes no licence file, so there is no upstream licence for this repository to carry, and none is asserted on his behalf here. The derived parts are redistributed on the same unstated terms as upstream; nothing in this repository re-licenses them. Anyone wanting clear terms should ask Amos Blomqvist. This repository stays private.

[`extensions/rtk/`](extensions/rtk/) is the one part with explicit terms. It adapts the Pi hook from [rtk-ai/rtk](https://github.com/rtk-ai/rtk) and carries that project's Apache-2.0 licence as [`extensions/rtk/LICENSE`](extensions/rtk/LICENSE).

Amos Blomqvist keeps several of his extensions in their own repositories, which this one does not vendor:

- **[pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents)**: async, interactive subagents in multiplexer panes
- **[pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory)**: tiered session memory with deterministic compaction
- **[pi-dictate](https://github.com/amosblomqvist/pi-dictate)**: real-time voice dictation inside pi
- **[learn](https://github.com/amosblomqvist/learn)**: his learning system, built on top of the original config

This repo contains everything else.

## Featherless model selection

[`profiles/featherless/`](profiles/featherless/) screens models from
[Abliterlitics](https://abliterlitics.dev/) for use through Featherless. Its catalogue
records exact IDs, dated provider limits, prices and experimental request settings.
All six entries are candidates. Ryan supplied the DavidAU entry as his current
baseline on 26 September 2026. There is no qualified default.

The workflow validates and stages a fresh profile, checks public provider metadata,
and prepares repeated Pi coding fixtures with independent outcome checks and spending
limits. Live runs are explicit; the default benchmark command only prints a plan.
See the [setup and evaluation guide](profiles/featherless/README.md).

[`profiles/featherless-qwen38/`](profiles/featherless-qwen38/) remains a historical
example for the same DavidAU model. Its older settings and benchmark figures do not
qualify the current workflow or the other candidates.

Credentials do not belong in this repository. Keep the Featherless key only in Pi's private
`~/.pi/agent/auth.json` store; never add it to `models.json`, settings, examples or documentation.

## Copy an extension

Single-file extension:

```bash
cp extensions/ask-user-question.ts ~/.pi/agent/extensions/
```

Directory extension:

```bash
cp -r extensions/browser ~/.pi/agent/extensions/
```

If the copied extension has a `package.json`, install its deps:

```bash
cd ~/.pi/agent/extensions/browser
npm install
```

Then restart pi or run `/reload`.

## Copy a skill

```bash
cp -r skills/pdf-reader ~/.pi/agent/skills/
```

Then restart pi or run `/reload`.

## Do not clone over your config

Avoid cloning this repo directly into `~/.pi/agent` unless it is a fresh setup. If you already use pi, copy individual files/folders instead so you don't replace your own config.

## Contents

### Extensions

- `ask-user-question.ts`: the agent asks you a question through a UI popup; popups from different extensions serialise via a shared UI lock
- `bash-guard/`: hooks that catch dangerous bash commands before they run, with an on/off toggle
- `browser/`: Playwright-driven headless Chromium the agent can drive (navigate, eval JS, inspect network/console, click, screenshot); off by default, enable with `/browser on`
- `custom-header.ts`: the big capital Π header
- `featherless-tool-bridge/`: validates and translates text tool envelopes from the older Featherless model
- `rtk/`: asks RTK to compress supported Bash command output after bash-guard checks the command
- `prompt-snippets/`: small, reusable behaviour rules toggled onto a message before sending; reset after send
- `web-fetch/`: fetch a URL and get clean markdown
  - Ryan's scope note: it fetches any address this machine can reach, loopback and private networks included; its private-address check only stops an internal URL going to the Jina fallback
- `web-search/`: web search

### Skills

- `analyze-sessions/`: Python scripts to query past pi sessions: cost rollups, prompt-pattern mining, session rendering
- `pdf-reader/`: read PDFs (lecture notes, papers) into the context
- `web-debug/`: a playbook for debugging frontend issues with the browser extension's tools
- `youtube-transcript/`: fetch a YouTube video's title and transcript as JSON

### Deprecated

`deprecated/` held the extensions and skills from the 2-month setup that were no longer in active use. They still worked; they just didn't earn their place. Removed on 7 September 2026; the tree at 0dceaf5 is the last one that holds them.

## Dependencies

Extension-local npm deps are kept with the extension. Run `npm install` only in copied extensions that include a `package.json`:

- `bash-guard/`
- `browser/` (also run `npx playwright install chromium` once)
- `web-fetch/`
- `web-search/`

`featherless-tool-bridge/` and `rtk/` have package manifests and tests but no npm dependencies to install.

Optional system tools:

```bash
brew install yt-dlp ffmpeg
```

Used by `youtube-transcript/`. Python 3 is needed for `youtube-transcript/` and `analyze-sessions/` (stdlib only).

PDF reader setup after copying `skills/pdf-reader/`:

```bash
python3 -m venv ~/.pi/agent/skills/pdf-reader/.venv
~/.pi/agent/skills/pdf-reader/.venv/bin/pip install -r ~/.pi/agent/skills/pdf-reader/requirements.txt
```

Rendered images remain in the user's private `pi-pdf-reader` cache until they
are removed. New renders stop when 64 render directories exist. Remove only
completed directories after their images are no longer needed; existing image
paths are never expired automatically.
