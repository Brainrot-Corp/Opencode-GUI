# opencode-gui

Lightweight Windows GUI client for [opencode](https://opencode.ai). Tauri v2 + React + TypeScript, talks to an `opencode serve` sidecar over HTTP.

![opencode-gui screenshot](./readme-ressources/opencode-gui-ressource.png)

See [PLAN.md](./PLAN.md) for architecture and [IMPLEMENTED.md](./IMPLEMENTED.md) for progress.

## Dev

```
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 setup   # first time: deps + sidecar binary
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 dev     # run the app
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 build     # packaged installers
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 portable  # portable zip: exe + sidecar, no install
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 check   # tsc + vite + cargo check
powershell -ExecutionPolicy Bypass -File scripts\run.ps1 clean   # cargo clean + remove dist
```

`scripts/run.sh` is the same runner for bash/WSL (`./scripts/run.sh dev`). The sidecar binary (`src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe`) is not committed; `setup` downloads it from [opencode releases](https://github.com/anomalyco/opencode/releases) automatically.

## Structure

State/server logic lives in `src/hooks/`, presentational pieces in `src/components/`, screens in `src/pages/`. Full tree and conventions in [PLAN.md](./PLAN.md).
