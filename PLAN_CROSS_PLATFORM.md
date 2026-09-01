# Cross-platform plan — macOS + Linux (same design, least dev effort)

> Decisions locked: custom titlebar + traffic-light inset · ship unsigned (no notarization) · CoreML/MPS later (CPU-only TTS/STT outside Windows) · remove `browser.rs` app launching (plugin later) · arch: `aarch64-apple-darwin` + `x86_64-unknown-linux-gnu` + `aarch64-unknown-linux-gnu`.
> Builds stay Windows-first; macOS/Linux reuse every existing feature except gated Windows-only ones. No new deps — delete/centralize > add.

## 0. Guiding rework — big diff once, zero drift after

Speculative “patch each call site” is the expensive path. Do one centralization first and every future feature is free:

| New helper | Replaces | Where |
|---|---|---|
| `src-tauri/src/platform.rs` — `home_dir()`, `config_dir(app)`, `reveal/open`, `sidecar_candidates()`, `default_shell()`, `opener_cmd()` | 7× `USERPROFILE`, 5× `xdg-open`, 3× `.exe` probe | `lib.rs:152,245,359`, `git.rs:26`, `pty.rs:26,60`, `voice.rs:34,889`, `browser.rs:240,401`, `update.rs:49` |
| `src/lib/workspace.ts:normalizeWorkspace()` reused in hooks | 4× `toLowerCase()` dedupe | `lib/workspace.ts:62`, `hooks/useOpencode.ts:528,577`, `hooks/useSettings.ts:279` |
| `src-tauri/src/terminals/` split `windows.rs`/`unix.rs` trait | 285 lines Windows-only probes | `terminals.rs:142-285` |

Without this, every new file/workspace/sidecar path re-introduces the same Windows bug.

---

## 1. What must change to compile & launch (P0)

### 1.1 Rust

| # | File:line | Problem | Fix |
|---|---|---|---|
| R1 | `lib.rs:152-205` `resolve_opencode_exe` | Probes `opencode.exe` / `opencode-x86_64-pc-windows-msvc.exe` only. Unix sidecars are `opencode` (no ext) with triples `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`. | Probe `["opencode","opencode-aarch64-apple-darwin","opencode-x86_64-apple-darwin","opencode-x86_64-unknown-linux-gnu","opencode-aarch64-unknown-linux-gnu"]` plus bare `opencode` on `PATH`; drop `.cmd` fallback on Unix; `chmod +x` after download (sidecar fetch). Keep `externalBin:["binaries/opencode"]` in `tauri.conf.json:35` — Tauri appends the triple automatically, no ext. |
| R2 | `lib.rs:245,359-366` `themes_dir()/plugins_dir()`, `voice.rs:34,888`, `git.rs:26`, `pty.rs:60,64`, `examples/tts_probe.rs:4` | `env::var("USERPROFILE")` → `""` on Unix → `/.config` root write / lost plugins. `workspace_file:114` already correct via `app.path().app_config_dir()`. | `platform.rs::home_dir() = dirs::home_dir() \|\| HOME \|\| USERPROFILE`; `config_dir(app) = app.path().app_config_dir()` everywhere; delete `themes_dir()` Windows XDG hardcode, make `kokoro_dir/whisper_dir/piper_dir` derive from `config_dir`. |
| R3 | `voice.rs:197`, `update.rs:49` | `Command::new("curl.exe")` — no `.exe` on Unix | `cfg(windows)"curl.exe" else "curl"`. |
| R4 | `browser.rs:401-429` `open_app`, `browser.rs:469-524` `window_app`, `launch_detached:425` | `where.exe`, `cmd /c start`, `powershell`, `taskkill`, `CREATE_NO_WINDOW` **ungarded** → compile error on Unix. `open_app` scans `%ProgramData%\Microsoft\Windows\Start Menu\Programs\*.lnk`, `window_app` shells `Get-Process`. | **Remove app launching for now** per decision: gate entire `open_app`/`window_app`/`launch_detached`/`collect_lnks`/`norm_app` behind `#[cfg(windows)]` and return `Err("app launching moved to plugin")` on other OS. Delete `use Command`/`CREATE_NO_WINDOW:274-279` from non-Windows build. Frontend already tolerates `invoke` error — hide voice “launch/quit app” intents on non-Windows. No `.desktop`/`.app` port now. |
| R5 | `lib.rs:576-599`, `608-656`, `browser.rs:263` `file_reveal/file_open/reveal_* / open_external` | `#[cfg(not(windows))] xdg-open` → fails on macOS (needs `open`). | `platform.rs::opener_cmd()`: `#[cfg(target_os="macos")] "open"` (and `open -R` for reveal), `#[cfg(target_os="linux")] "xdg-open"`, Windows `explorer`/`cmd /c start` unchanged. One helper, 5 call sites. |
| R6 | `pty.rs:26` `default_shell` | `unwrap_or("powershell.exe")` → fails when `SHELL` unset on minimal env | `#[cfg(windows)] "powershell.exe" else env::var("SHELL").unwrap_or("/bin/zsh".to_string())` fallback `/bin/bash`. |
| R7 | `terminals.rs:19-57,142-285` | `where_lookup` (even `not(windows)` branch calls `where`), hardcodes `C:\Windows\...`, `Program Files\PowerShell`, `COMSPEC=cmd.exe`, `USERPROFILE/scoop/shims/bash.exe`, WSL/WT probes | Split: `cfg(windows)` keeps current `probe_shells/windows`; `cfg(unix)` new `probe_unix` → `which bash/zsh/fish/pwsh`, `/etc/shells`, `chsh` fallback. `where_lookup` → `which` on Unix. Gate `wsl_available()/wsl_distros()`/`wt_profiles:665` behind `cfg(windows)` (return empty on other OS). |
| R8 | `tauri.conf.json:33` | `"targets":["msi"]` Windows-only; mac needs `dmg`/`app`, Linux `deb`/`appImage` | Least effort: set `"targets":[]` or `"all"` (Tauri picks per-OS) + `"externalBin":["binaries/opencode"]` stays. Keep icons `tauri.conf.json:37-43` (`icon.icns` already present). Add `bundle.macOS:{minimumSystemVersion:"10.15"}` stub later; no entitlements/signing for unsigned ship. Keep `app.windows[0].additionalBrowserArgs:24` — ignored on other WebViews, harmless. |

No change needed (already cfg-gated): `job::assign:47-109`, `window-vibrancy/jumplist_win/winreg/webview2-com/windows:53-59`, `autostart.rs:85-110` (`tauri_plugin_autostart` → `LaunchAgent` on mac, `XDG Autostart` on Linux), `discord.rs`, `build.rs`, `portable-pty` (ConPTY→`forkpty`).

### 1.2 Rust high (runs but broken)

| # | File:line | Issue | Fix |
|---|---|---|---|
| R9 | `lib.rs:338-355` `apply_glass`, `Cargo.toml:53` | `apply_acrylic` only on Windows; `window-vibrancy` is `cfg(windows)` so mac can’t call `apply_vibrancy`. Without it `transparent:true` shows black on mac. | Move `window-vibrancy = "0.6"` out of `cfg(windows)` (it supports mac `apply_vibrancy`/`apply_blur` + Linux passthrough). `platform::apply_glass(app)`: Windows `apply_acrylic`, macOS `apply_vibrancy(&w, Sidebar, None)`, Linux no-op. Frontend `os_glass:334`/`main.tsx:45` opaque fallback already correct. Keeps exact glass `rgba(20,28,35,.14)→blur 14px` via `backdrop-filter`. |
| R10 | `voice.rs:116-174`, `voice.rs:913` | `Get-CimInstance Win32_VideoController`, `SetDllDirectoryW`, `KOKORO_GPU_DLLS` `.dll` only | Gate GPU path `cfg(windows)`; on non-Windows `voice_gpu()` returns `{nvidia:false}` and `enable_kokoro_gpu_search()` becomes CPU-only no-op. Keep ONNX Runtime CUDA pack detection Windows-only; mac/Linux ship CPU model. CoreML/MPS deferred. |
| R11 | `update.rs:27-368` | Assumes flat `opencode-gui.exe+opencode.exe` zip, `curl.exe`, `ping -n`, `start ""`, `autostart` bat | Gate updater `cfg(windows)` for portable self-update. On mac/Linux stub `update_download/update_stage_local → Err("auto-update only on Windows")`, `apply_on_exit` keeps existing `#[cfg(not(windows))]` `spawn` branch `364-368` (no-op install). Unsigned ship needs no `tauri-plugin-updater`/Sparkle yet. |
| R12 | `lib.rs:263-270` | Release `CREATE_NO_WINDOW+Stdio::null` only on Windows — Linux release inherits stdio | `Stdio::null` for all `not(debug_assertions)`. One-line. |

### 1.3 Frontend

| # | File:line | Problem | Fix |
|---|---|---|---|
| F1 | `lib/workspace.ts:62,74`, `hooks/useOpencode.ts:528,577`, `hooks/useSettings.ts:279` | `toLowerCase()` dedupe collapses `~/MyApp` vs `~/myapp` on case-sensitive APFS/ext4. **P0 on Linux.** | New `normalizeWorkspace(dir)` → exact string on `darwin/Linux`, `toLowerCase` only when `navigator.platform` has `Win`. Replace all 4 copies with import. |
| F2 | `hooks/useGlobalShortcuts.ts:216`, `lib/hotkeys.ts:52-80` | `Alt+Space` (Windows menu), all defaults `Ctrl+*`, `Ctrl+wheel` zoom ignores `metaKey`. | `isMac = navigator.platform.includes("Mac")` — gate `Alt+Space` suppression behind `!isMac`; map display `Ctrl → ⌘` (keep `matchesEvent:194` alias `Meta→Ctrl` for matching); wheel zoom accepts `ctrlKey \|\| metaKey`. |
| F3 | `lib/editorKeys.ts:122` | `split("\n")` leaves `\r` when file has `\r\n` (`autocrlf=true`) | `split(/\r?\n/)` or normalize to `\n` on load, keep detected EOL on save. |
| F4 | `components/FileTree.tsx:147` `joinAbs` | `sep = base.includes("\\") ? "\\" : "/"` wrong on POSIX if pasted `C:\...` | Reuse `platform.ts` `joinPath` that normalizes to `/` on Unix. Minor. |
| F5 | `Titlebar.tsx` + `styles/layout.css` + `tauri.conf.json:20` | `decorations:false transparent:true` custom chrome. On mac traffic lights (stoplights) missing/overlap. | **Custom + inset** per decision: keep `decorations:false` on all OS, on mac add CSS var `--traffic-inset: 76px` left padding to titlebar, set `tauri.conf.json:app.windows[0].titleBarStyle:"overlay" hiddenTitle:true` only for mac overlay hit area (no native chrome). No new layout. |

Design parity otherwise intact: tokens `6px` unit, `accent #7fd4d4`, `glass rgba+blur 14px` via R9, square scrollbars, `Inter`/`JetBrains Mono` via `index.html:7-12` (+ `system-ui/-apple-system` fallback), Font Awesome, native cursors (Windows `.cur` pack `lib.rs:1455` falls back to PNG — `main.tsx:54` catch already handles).

---

## 2. Build, sidecar, scripts

| # | File:line | Current | Fix |
|---|---|---|---|
| B1 | `scripts/run.sh:41-58` + `scripts/run.ps1:15,61-73` | Both fetch `opencode-windows-x64.zip` into `opencode-x86_64-pc-windows-msvc.exe`; no `chmod +x`. | `fetch_sidecar()` branch on `uname -s`/`uname -m`: `Darwin/arm64 → opencode-darwin-arm64.zip → opencode-aarch64-apple-darwin`, `Linux/x86_64 → opencode-linux-x64.zip → opencode-x86_64-unknown-linux-gnu`, `Linux/aarch64 → opencode-linux-arm64.zip → opencode-aarch64-unknown-linux-gnu`. `mv opencode` then `chmod +x`. `run.ps1` keeps Windows branch; `run.sh` becomes true cross-platform. Use `anomalyco/opencode` releases (existing fork) or switch to `sst/opencode` asset names if needed — verify asset list. |
| B2 | `scripts/run.sh:35` `sed -i` | `sed -i` BSD vs GNU (`macos: sed -i ''` needed) + naive global `version` replace clobbers `package-lock` deps | `sed -i.bak -E … && rm *.bak` + replicate `run.ps1:35` scoped replace `("name": "opencode-gui" … "version")`. Port `Set-Version` logic to `run.sh`. |
| B3 | `scripts/run.sh:66-110` `build/portable` | `win11/win10` glass variants + `msi/nsis` + `opencode-gui.exe+opencode.exe` zip | Detect host: macOS `build_one app,dmg` → `bundle/macos/*.app` + `bundle/dmg/*.dmg`; Linux `build_one deb,appimage` → `bundle/deb/*.deb` + `bundle/appimage/*.AppImage`; Windows keep `win11/win10`+`msi/nsis`+`noglass` flag. Portable: zip `.app` on mac, tar `.AppImage` on Linux. Drop `TARGET=win11` default on non-Windows — single build without feature flag. |
| B4 | `.github/workflows/release.yml:13` | Single `windows-latest` job | Matrix `windows-latest` / `macos-14` / `ubuntu-22.04` + arch where needed; each runs `run.sh setup` → `tauri build` per OS; upload `*.msi/*.dmg/*.AppImage/*.deb` + sidecar inside bundle. Linux deps: `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`. |
| B5 | Sidecar CI | CI assumes `src-tauri/binaries/` pre-populated | Add `setup` step per matrix job before `tauri build`; `.gitignore:16` `binaries/` stays (never commit sidecars). |

---

## 3. Phased execution (no code yet — approval gate)

| Phase | Scope | Gate |
|---|---|---|
| **0 — Foundation** | Create `platform.rs` + `platform.ts`, move `home_dir/config_dir/opener/sidecar_candidates/default_shell` out of `lib.rs` | `cargo check` on all three targets passes |
| **1 — Compile** | R1-R8: sidecar probe, home fix, curl rename, file-open branch, pty default shell, terminals split, tauri targets `all`, remove app-launch | `run.sh setup` fetches correct triple; app launches, sidecar serves, window shows |
| **2 — High** | R9 glass cross-platform, R10-R12 voice/update stubs, F1-F5 frontend fixes | Glass visible on mac (vibrancy), workspace case correct, hotkeys show `⌘`, no `Alt+Space` conflict |
| **3 — Build** | B1-B5 scripts + CI matrix, unsigned `dmg`/`deb`/`AppImage` | Local `run.sh build` on mac (arm64) + Linux x64+arm64 produces bundles; CI publishes them |

Effort ~3 days focused; Phase 0 pays back every future change (no second drift).

### Verification per phase

- **Phase 1**: `cargo check` (or `run.sh check`) on each host; `./scripts/run.sh dev` → create session → `prompt_async` → SSE stream → permission approve/deny → abort mid-stream (smoke from `PLAN.md:119-122`).
- **Phase 2**: manual hotkey test (mac `Cmd+B` sidebar, `Cmd+wheel` zoom), file reveal in Finder vs Nautilus, case-sensitive workspace dirs.
- **Phase 3**: `ls src-tauri/target/release/bundle/{dmg,appImage,deb,msi}` per runner.

---

## 4. Decisions & non-goals

- **Titlebar**: custom + traffic-light inset (76px left pad, `titleBarStyle:overlay hiddenTitle:true` only for overlay hit area) — keeps exact same design system, least churn vs native `decorations:true`.
- **Sign/notarize**: unsigned for now — Gatekeeper warning acceptable; `bundle.macOS.signingIdentity` omitted, no `entitlements.plist` yet. When signed, add `entitlements` + hardened runtime.
- **Voice**: CPU-only on mac/Linux — whisper `whisper-cli` without `.exe`, Kokoro GPU pack ignored outside Windows, `voice_gpu()` stubbed false; CoreML/MPS tracked separately.
- **App launching**: deleted, not ported to `.desktop`/`open -a` — voice “launch/quit/minimize” intents become plugin surface.
- **Arch**: `aarch64-apple-darwin` (mac arm64), `x86_64-unknown-linux-gnu` + `aarch64-unknown-linux-gnu` (Linux both). No `x86_64-apple-darwin` Intel mac.

No new dependency: reuse `dirs` via `app.path()` + stdlib + `window-vibrancy` already in repo.
