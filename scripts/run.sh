#!/usr/bin/env bash
# OpenCode GUI task runner (cross-platform)
# usage:  ./scripts/run.sh <command> [native|win11|win10|both] [bundles] [--version X.Y.Z]
# commands: setup | dev | build | portable | check | clean
#  native = current OS (default on macOS/Linux), win11/win10 = Windows glass variants (only on Windows)
set -e
cd "$(dirname "$0")/.."

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
        npm install
        fetch_sidecar
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
        if [ "$IS_WINDOWS" = true ]; then
            rel="src-tauri/target/release"
            out="$rel/bundle/portable"
            for t in $TARGETS; do
                build_one "$t" nobundle
                mkdir -p "$out/OpenCode"
                cp "$rel/opencode-gui.exe" "$out/OpenCode/" 2>/dev/null || cp "$rel/opencode-gui" "$out/OpenCode/" 2>/dev/null || true
                # sidecar
                if [ -f "$rel/opencode.exe" ]; then cp "$rel/opencode.exe" "$out/OpenCode/"; elif [ -f "$rel/opencode" ]; then cp "$rel/opencode" "$out/OpenCode/"; fi
                (cd "$out" && zip -qr "opencode-gui-$t-x64.zip" OpenCode)
                echo ">> portable [$t]: $out/opencode-gui-$t-x64.zip"
            done
        else
            echo ">> portable: on macOS/Linux use 'build' (produces .app/.dmg/.AppImage/.deb)"
            for t in $TARGETS; do build_one "$t" "" "$BUNDLES"; done
        fi
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
