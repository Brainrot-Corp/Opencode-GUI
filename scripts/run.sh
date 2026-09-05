#!/usr/bin/env bash
# OpenCode GUI task runner (cross-platform)
# usage:  ./scripts/run.sh <command> [native|win11|win10|both] [bundles] [--version X.Y.Z]
# commands: setup | dev | build | portable | check | clean
#  native = current OS (default on macOS/Linux), win11/win10 = Windows glass variants (only on Windows)
set -e
cd "$(dirname "$0")/.."

# sudo guard: do not run with sudo (creates root-owned ~/.npm/_cacache → EACCES)
# If invoked via `sudo ./scripts/run.sh`, warn and fix HOME. NOTE: placed before CMD parsing, so $CMD not yet available.
if [ "$(id -u 2>/dev/null || echo 0)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    echo "!! you ran with sudo — do not use sudo for setup/build (creates root-owned files in ~/.npm, ~/.cargo)" >&2
    echo "!!   fix existing: sudo chown -R $SUDO_USER \"$(eval echo ~$SUDO_USER)/.npm\" \"$(eval echo ~$SUDO_USER)/.cargo\" 2>/dev/null || true" >&2
    echo "!!   re-run without sudo:  bash scripts/run.sh setup  (or ./scripts/run.sh setup after chmod +x)" >&2
    # keep HOME as original user so npm/cargo don't write to /var/root
    _orig_home=$(eval echo "~$SUDO_USER" 2>/dev/null || echo "$HOME")
    if [ -n "$_orig_home" ] && [ -d "$_orig_home" ]; then
        export HOME="$_orig_home"
        export USER="$SUDO_USER"
        if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env" 2>/dev/null || true; fi
        for _d in "$HOME/.cargo/bin" "$HOME/.rustup/bin"; do
            case ":$PATH:" in *":$_d:"*) ;; *) [ -d "$_d" ] && export PATH="$_d:$PATH" ;; esac
        done
        unset _d
    fi
    echo ">> continuing as $SUDO_USER (HOME=$HOME) — if this fails, re-run without sudo" >&2
fi

VERSION=""
POS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:-}"; shift 2 ;;
        *) POS+=("$1"); shift ;;
    esac
done
CMD="${POS[0]:-dev}"
TARGET="${POS[1]:-native}"
BUNDLES="${POS[2]:-}"

OS=$(uname -s 2>/dev/null || echo "Windows")
ARCH=$(uname -m 2>/dev/null || echo "x86_64")
IS_WINDOWS=false
case "$OS" in MINGW*|MSYS*|CYGWIN*|Windows*) IS_WINDOWS=true ;; esac

# map OS/arch to opencode asset + sidecar triple
if [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
        ASSET="opencode-darwin-arm64.zip"
        TRIPLE="aarch64-apple-darwin"
    else
        ASSET="opencode-darwin-x64.zip"
        TRIPLE="x86_64-apple-darwin"
    fi
    SIDECAR="src-tauri/binaries/opencode-$TRIPLE"
elif [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        ASSET="opencode-linux-arm64.zip"
        TRIPLE="aarch64-unknown-linux-gnu"
    else
        ASSET="opencode-linux-x64.zip"
        TRIPLE="x86_64-unknown-linux-gnu"
    fi
    SIDECAR="src-tauri/binaries/opencode-$TRIPLE"
else
    ASSET="opencode-windows-x64.zip"
    TRIPLE="x86_64-pc-windows-msvc"
    SIDECAR="src-tauri/binaries/opencode-$TRIPLE.exe"
fi
# allow override via existing Windows sidecar name for compatibility
if [ "$IS_WINDOWS" = true ] && [ "$TARGET" != "native" ]; then
    SIDECAR="src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe"
    ASSET="opencode-windows-x64.zip"
fi

# resolve TARGETS
if [ "$TARGET" = "native" ]; then
    TARGETS="native"
elif [ "$IS_WINDOWS" = true ]; then
    case "$TARGET" in
        win11) TARGETS="win11" ;;
        win10) TARGETS="win10" ;;
        both)  TARGETS="win10 win11" ;;
        *) echo "!! target must be native, win11, win10 or both"; exit 1 ;;
    esac
else
    echo "!! on macOS/Linux use target 'native' (win11/win10 only on Windows)"; exit 1
fi

set_version() {
    if ! printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+){1,2}$'; then
        echo "!! invalid version '$1' - use e.g. 1.5.2"; exit 1
    fi
    echo ">> bumping version to $1"
    # BSD sed (macOS) needs backup suffix; GNU sed tolerates -i.bak too
    for f in src-tauri/tauri.conf.json package.json; do
        sed -i.bak -E 's/"version": "[^"]*"/"version": "'"$1"'"/' "$f" && rm -f "$f.bak"
    done
    # package-lock.json: scope to app name to avoid rewriting deps
    if [ -f package-lock.json ]; then
        # use node to safely bump without touching deps
        node -e "let fs=require('fs');let p='package-lock.json';let j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='$1';if(j.packages&&j.packages['']){j.packages[''].version='$1'};fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    fi
    sed -i.bak -E 's/^version = ".*"/version = "'"$1"'"/' src-tauri/Cargo.toml && rm -f src-tauri/Cargo.toml.bak
    echo ">> version set to $1"
}
[ -n "$VERSION" ] && set_version "$VERSION"

# ensure cargo is available in PATH for this session (rustup without restart)
if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env" 2>/dev/null || true; fi
for _d in "$HOME/.cargo/bin" "$HOME/.rustup/bin" "$USERPROFILE/.cargo/bin" "/c/Users/$USERNAME/.cargo/bin"; do
    case ":$PATH:" in *":$_d:"*) ;; *) [ -d "$_d" ] && export PATH="$_d:$PATH" ;; esac
done
unset _d 2>/dev/null || true

ensure_rust() {
    if command -v cargo >/dev/null 2>&1; then
        echo ">> cargo $(cargo --version) ready"
        return 0
    fi
    echo ">> cargo not found, installing rustup..."
    if [ "$IS_WINDOWS" = true ]; then
        if command -v winget >/dev/null 2>&1; then
            echo ">> trying winget install Rustlang.Rustup..."
            winget install --id Rustlang.Rustup --silent --accept-package-agreements --accept-source-agreements || true
            for _d in "$USERPROFILE/.cargo/bin" "$HOME/.cargo/bin" "/c/Users/$USERNAME/.cargo/bin"; do
                [ -d "$_d" ] && export PATH="$_d:$PATH"
            done
            unset _d
        fi
        if ! command -v cargo >/dev/null 2>&1; then
            echo ">> downloading rustup-init.exe..."
            _tmp_exe=$(mktemp /tmp/rustup-init.XXXXXX.exe)
            if curl -fsSL https://win.rustup.rs/x86_64 -o "$_tmp_exe"; then
                "$_tmp_exe" -y --no-modify-path 2>&1 || "$_tmp_exe" -y 2>&1 || true
                rm -f "$_tmp_exe"
            else
                echo "!! failed to download rustup-init.exe"
                rm -f "$_tmp_exe"
            fi
            for _d in "$USERPROFILE/.cargo/bin" "$HOME/.cargo/bin" "/c/Users/$USERNAME/.cargo/bin"; do
                [ -d "$_d" ] && export PATH="$_d:$PATH"
            done
            unset _d
        fi
    else
        # macOS / Linux
        if command -v curl >/dev/null 2>&1; then
            curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path || curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path || true
        else
            echo "!! curl not found, cannot install rustup automatically"
        fi
        if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env" 2>/dev/null || true; fi
        export PATH="$HOME/.cargo/bin:$PATH"
        # Linux: hint about Tauri system deps if missing
        if [ "$OS" = "Linux" ] && ! pkg-config --exists webkit2gtk-4.1 2>/dev/null && ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
            echo ">> note: Tauri on Linux requires webkit2gtk, libappindicator, etc. See https://v2.tauri.app/start/prerequisites/#linux"
        fi
    fi
    if ! command -v cargo >/dev/null 2>&1; then
        echo "!! cargo still not found after install. Add \$HOME/.cargo/bin to PATH and restart shell."
        echo "!!   export PATH=\"\$HOME/.cargo/bin:\$PATH\""
        exit 1
    fi
    echo ">> cargo installed: $(cargo --version) / rustc $(rustc --version 2>/dev/null || echo 'n/a')"
}

ensure_node_deps() {
    echo ">> installing npm dependencies..."
    if npm install 2>&1; then
        return 0
    fi
    _code=$?
    echo ">> npm install failed (code $_code), checking cache permissions..."
    if find "${NPM_CONFIG_CACHE:-$HOME/.npm}" -user root 2>/dev/null | grep -q .; then
        echo ">> found root-owned files in npm cache, retrying with temp cache..."
    fi
    # retry with isolated cache (works around EACCES from earlier sudo npm)
    if NPM_CONFIG_CACHE=/tmp/npm-cache npm install; then
        echo ">> npm install succeeded with temp cache (consider: sudo chown -R \$(id -u):\$(id -g) ~/.npm)"
        return 0
    fi
    echo "!! npm install failed even with temp cache"
    return 1
}

fetch_sidecar() {
    mkdir -p src-tauri/binaries
    echo ">> fetching $ASSET for $OS/$ARCH → $SIDECAR"
    url=$(curl -fsSL https://api.github.com/repos/anomalyco/opencode/releases/latest \
        | grep -o '"browser_download_url": *"[^"]*'"$ASSET"'"' \
        | head -1 | sed 's/.*"\(https[^"]*\)".*/\1/')
    if [ -z "$url" ]; then
        # fallback to sst/opencode
        url=$(curl -fsSL https://api.github.com/repos/sst/opencode/releases/latest \
            | grep -o '"browser_download_url": *"[^"]*'"$ASSET"'"' \
            | head -1 | sed 's/.*"\(https[^"]*\)".*/\1/')
    fi
    [ -n "$url" ] || { echo "!! could not find $ASSET in latest release"; exit 1; }
    zip=$(mktemp /tmp/opencode-sidecar.XXXXXX.zip)
    tmp=$(mktemp -d /tmp/opencode-sidecar-extract.XXXXXX)
    curl -fsSL "$url" -o "$zip"
    unzip -oq "$zip" -d "$tmp"
    # find opencode binary inside
    bin=$(find "$tmp" -type f -name "opencode*" | head -1)
    if [ -z "$bin" ]; then bin="$tmp/opencode"; fi
    if [ ! -f "$bin" ] && [ -f "$tmp/opencode.exe" ]; then bin="$tmp/opencode.exe"; fi
    [ -f "$bin" ] || { echo "!! opencode binary not found in zip"; ls -R "$tmp"; exit 1; }
    mv "$bin" "$SIDECAR"
    chmod +x "$SIDECAR" 2>/dev/null || true
    rm -rf "$zip" "$tmp"
    echo ">> sidecar ready:"
    "$SIDECAR" --version || true
    # also ensure legacy Windows name exists on Windows for compat if needed
    if [ "$IS_WINDOWS" = true ] && [ "$SIDECAR" != "src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe" ]; then
        cp "$SIDECAR" "src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe" 2>/dev/null || true
    fi
}

build_one() {
    local extra=""
    [ "$2" = "nobundle" ] && extra="--no-bundle"
    [ -n "$3" ] && extra="$extra --bundles $3"
    if [ "$1" = "win10" ]; then
        npm run tauri build -- --features noglass $extra
    else
        npm run tauri build -- $extra
    fi
}

case "${CMD}" in
    setup)
        ensure_rust
        ensure_node_deps
        fetch_sidecar
        echo ">> verifying Rust toolchain..."
        cargo --version 2>&1 || true
        echo ">> setup complete"
        ;;
    dev)
        # check any known sidecar exists
        if ! ls src-tauri/binaries/opencode* 1>/dev/null 2>&1; then
            echo "!! sidecar missing, run setup first"; exit 1
        fi
        npm run tauri dev
        ;;
    build)
        if ! command -v cargo >/dev/null 2>&1; then
            echo "!! cargo not found, run './scripts/run.sh setup' first (installs rustup)"
            exit 1
        fi
        for t in $TARGETS; do
            build_one "$t" "" "$BUNDLES"
            bundle="src-tauri/target/release/bundle"
            if [ "$t" = "native" ] && [ "$IS_WINDOWS" = false ]; then
                echo ">> [native] bundle in $bundle"
                ls -lh "$bundle" 2>/dev/null || true
                find "$bundle" -maxdepth 3 -type f \( -name "*.dmg" -o -name "*.app" -o -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) 2>/dev/null | head -20
            else
                # Windows: suffix installers
                find "$bundle/nsis" "$bundle/msi" -type f \( -name "*.exe" -o -name "*.msi" \) 2>/dev/null |
                    while read -r f; do
                        base="${f%.*}"; ext="${f##*.}"
                        cp "$f" "$bundle/$(basename "$base")-$t.$ext"
                    done || true
                echo ">> [$t] installers in $bundle (*-$t.*)"
            fi
        done
        ;;
    portable)
        if ! command -v cargo >/dev/null 2>&1; then
            echo "!! cargo not found, run './scripts/run.sh setup' first (installs rustup)"
            exit 1
        fi
        rel="src-tauri/target/release"
        out="$rel/bundle/portable"
        for t in $TARGETS; do
            # macOS portable must be a .app bundle — raw Mach-O binary always spawns Terminal on double-click
            if [ "$OS" = "Darwin" ]; then
                build_one "$t" "" ""
            else
                build_one "$t" nobundle
            fi
            bundle="$rel/bundle"
            if [ "$IS_WINDOWS" = true ]; then
                mkdir -p "$out/OpenCode"
                cp "$rel/opencode-gui.exe" "$out/OpenCode/" 2>/dev/null || cp "$rel/opencode-gui" "$out/OpenCode/" 2>/dev/null || true
                if [ -f "$rel/opencode.exe" ]; then cp "$rel/opencode.exe" "$out/OpenCode/"; elif [ -f "$rel/opencode" ]; then cp "$rel/opencode" "$out/OpenCode/"; elif [ -f "$SIDECAR" ]; then cp "$SIDECAR" "$out/OpenCode/opencode.exe" 2>/dev/null || cp "$SIDECAR" "$out/OpenCode/opencode" 2>/dev/null || true; fi
                (cd "$out" && zip -qr "opencode-gui-$t-x64.zip" OpenCode)
                echo ">> portable [$t]: $out/opencode-gui-$t-x64.zip"
                ls -lh "$out/opencode-gui-$t-x64.zip" 2>/dev/null || true
            else
                # macOS / Linux: create portable folder + archive
                mkdir -p "$out/OpenCode"
                # main binary
                if [ -f "$rel/opencode-gui" ]; then cp "$rel/opencode-gui" "$out/OpenCode/"; elif [ -f "$rel/opencode-gui.exe" ]; then cp "$rel/opencode-gui.exe" "$out/OpenCode/"; fi
                # sidecar: prefer built, fallback to source sidecar
                if [ -f "$rel/opencode" ]; then cp "$rel/opencode" "$out/OpenCode/"; elif [ -f "$rel/opencode.exe" ]; then cp "$rel/opencode.exe" "$out/OpenCode/"; elif [ -f "$SIDECAR" ]; then cp "$SIDECAR" "$out/OpenCode/" 2>/dev/null || true; fi
                if [ "$OS" = "Darwin" ]; then
                    _app=$(find "$bundle/macos" -maxdepth 2 -name "*.app" -type d 2>/dev/null | head -1)
                    if [ -z "$_app" ]; then _app=$(find "$bundle" -maxdepth 3 -name "*.app" -type d 2>/dev/null | head -1); fi
                    if [ -n "$_app" ] && [ -d "$_app" ]; then
                        echo ">> portable is $_app (no Terminal on double-click)"
                        # zip the .app directly — double-click the .app, not the raw binary
                        _arch=$(uname -m)
                        _app_name=$(basename "$_app")
                        rm -rf "$out/$_app_name"
                        cp -R "$_app" "$out/"
                        (cd "$out" && zip -qr -y "opencode-gui-$t-$_arch.zip" "$_app_name")
                        echo ">> portable [$t]: $out/opencode-gui-$t-$_arch.zip (double-click $_app_name)"
                        ls -lh "$out/opencode-gui-$t-$_arch.zip" 2>/dev/null || true
                        # also keep raw binaries alongside for CLI use, but warn
                        echo ">> note: $out/OpenCode/opencode-gui is CLI-only (double-click opens Terminal); use the .app"
                    else
                        echo "!! .app not found in $bundle — falling back to raw binary (will open Terminal on double-click)"
                        _arch=$(uname -m)
                        (cd "$out" && zip -qr "opencode-gui-$t-$_arch.zip" OpenCode)
                        echo ">> portable [$t]: $out/opencode-gui-$t-$_arch.zip"
                        ls -lh "$out/opencode-gui-$t-$_arch.zip" 2>/dev/null || true
                    fi
                else
                    # Linux: tar.gz
                    _arch=$(uname -m)
                    (cd "$out" && tar -czf "opencode-gui-$t-$_arch.tar.gz" OpenCode 2>/dev/null || zip -qr "opencode-gui-$t-$_arch.zip" OpenCode)
                    echo ">> portable [$t]: $out/opencode-gui-$t-$_arch.tar.gz"
                    ls -lh "$out"/opencode-gui-$t-*.tar.gz "$out"/opencode-gui-$t-*.zip 2>/dev/null | head -5
                fi
                echo ">> portable content:"
                ls -lh "$out/OpenCode/" 2>/dev/null || true
            fi
        done
        ;;
    check)
        npm run build
        (cd src-tauri && cargo check)
        ;;
    clean)
        (cd src-tauri && cargo clean)
        rm -rf dist
        echo ">> cleaned"
        ;;
    *)
        echo "usage: run.sh [setup|dev|build|portable|check|clean] [native|win11|win10|both] [bundles] [--version X.Y.Z]"
        exit 1
        ;;
esac
