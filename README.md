# opencode-gui

Lightweight cross-platform GUI client for [opencode](https://opencode.ai). Tauri v2 + React + TypeScript, spawns an `opencode serve` sidecar and talks to it over HTTP/SSE.

![opencode-gui screenshot](./readme-ressources/opencode-gui-ressource.png)

See [PLAN.md](./PLAN.md) for architecture and [IMPLEMENTED.md](./IMPLEMENTED.md) for progress.

## Requirements

Windows 10/11 (WebView2 ships with Windows), Node 20+, Rust stable + MSVC Build Tools.

## Dev

Run everything through `scripts/run.sh` (Git Bash on Windows, bash/WSL elsewhere):

```
./scripts/run.sh setup    # first time: npm deps + rustup (if missing) + sidecar binary
./scripts/run.sh dev      # run the app
./scripts/run.sh build    # bundle → src-tauri/target/release/bundle
./scripts/run.sh portable # portable zip (exe + sidecar) → bundle/portable
./scripts/run.sh check    # unit tests + tsc + vite build + cargo check
./scripts/run.sh clean    # cargo clean + remove dist
```

On Windows you can also use the native PowerShell runner — no Git Bash needed:

```
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 dev
```

Both runners are maintained on purpose (`run.sh` = cross-platform default, `run.ps1` = native Windows wrapper) — keep them in sync when a command changes.

`build`/`portable` take an optional target `native` (default, current OS) or — on Windows only — `win11` (glass/acrylic) / `win10` (no-glass) / `both`, plus an optional bundle list (`msi`, `nsis`); e.g. `./scripts/run.sh build win11 "msi nsis"`. A version bump before a release: `./scripts/run.sh build --version 2.3.0`. The sidecar binary (`src-tauri/binaries/opencode-*`) is not committed; `setup` downloads the correct triple from [opencode releases](https://github.com/anomalyco/opencode/releases) automatically.

## Structure

State/server logic lives in `src/hooks/`, presentational pieces in `src/components/` (one CSS file each in `src/styles/`), screens in `src/pages/`. Full tree and conventions in [PLAN.md](./PLAN.md); design tokens and persistence keys in [AGENTS.md](./AGENTS.md).

## Plugins

Optional features ship as runtime plugins. A plugin is a folder with `plugin.json` + `main.js` (+ optional `styles.css`) under `%USERPROFILE%\.config\.opencode-gui\plugins\` (next to `themes.json`). Plugins are browser ESM: `main.js` default-exports `activate(api)` and can contribute voice intents, settings sections, `info.voice`/`info.keys` docs, and spoken feedback. Files hot-reload on save; broken plugins surface as a banner and are skipped.

Install the bundled example (voice control for Tuya Smart Life bulbs — on/off, brightness, white tone, color):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\.opencode-gui\plugins" | Out-Null
Copy-Item -Recurse default_plugins\tuya-lights-control "$env:USERPROFILE\.config\.opencode-gui\plugins\"
```

Then set credentials in Settings › Lights (free project at iot.tuya.com). See [default_plugins/tuya-lights-control](./default_plugins/tuya-lights-control) for the full API example; its `test.mjs` is a runnable self-check.
