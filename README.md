# opencode-gui

Lightweight Windows GUI client for [opencode](https://opencode.ai). Tauri v2 + React + TypeScript, talks to an `opencode serve` sidecar over HTTP.

See [PLAN.md](./PLAN.md) for architecture and [IMPLEMENTED.md](./IMPLEMENTED.md) for progress.

## Dev

```
npm install
npm run tauri dev
```

The sidecar binary (`src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe`) is not committed; download from [opencode releases](https://github.com/anomalyco/opencode/releases) (`opencode-windows-x64.zip`) and place it at that path.

## Structure

State/server logic lives in `src/hooks/`, presentational pieces in `src/components/`, screens in `src/pages/`. Full tree and conventions in [PLAN.md](./PLAN.md).
