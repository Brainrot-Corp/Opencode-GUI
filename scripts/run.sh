#!/usr/bin/env bash
# OpenCode GUI task runner (Linux/WSL/macOS)
# usage:  ./scripts/run.sh <command> [win11|win10|both] [bundles] [--version X.Y.Z]
# commands: setup | dev | build | check | clean   (build/portable take a target, default win11)
# win11 = glass build (acrylic), win10 = no-glass build (--features noglass)
# build only: 3rd arg picks bundle types (default msi per tauri.conf.json; e.g. "nsis")
# --version X.Y.Z bumps the version in tauri.conf.json / Cargo.toml / package.json / package-lock.json first
set -e
cd "$(dirname "$0")/.."

# parse --version out of the args so the rest stay positional
VERSION=""
POS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="${2:-}"; shift 2 ;;
        *) POS+=("$1"); shift ;;
    esac
done
CMD="${POS[0]:-dev}"
TARGET="${POS[1]:-win11}"
BUNDLES="${POS[2]:-}"
case "$TARGET" in
    win11) TARGETS="win11" ;;
    win10) TARGETS="win10" ;;
    both)  TARGETS="win10 win11" ;; # win11 last → it stays staged in OpenCode/
    *) echo "!! target must be win11, win10 or both"; exit 1 ;;
esac

set_version() {
    if ! printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+){1,2}$'; then
        echo "!! invalid version '$1' - use e.g. 1.5.2"; exit 1
    fi
    echo ">> bumping version to $1"
    sed -i -E 's/"version": "[^"]*"/"version": "'"$1"'"/' src-tauri/tauri.conf.json package.json package-lock.json
    sed -i -E 's/^version = ".*"/version = "'"$1"'"/' src-tauri/Cargo.toml
    echo ">> version set to $1 in tauri.conf.json, Cargo.toml, package.json, package-lock.json"
}
[ -n "$VERSION" ] && set_version "$VERSION"

SIDEcar="src-tauri/binaries/opencode-x86_64-pc-windows-msvc.exe"

fetch_sidecar() {
    mkdir -p src-tauri/binaries
    echo ">> fetching latest opencode windows binary..."
    url=$(curl -fsSL https://api.github.com/repos/anomalyco/opencode/releases/latest \
        | grep -o '"browser_download_url": *"[^"]*opencode-windows-x64.zip"' \
        | head -1 | sed 's/.*"\(https[^"]*\)".*/\1/')
    [ -n "$url" ] || { echo "!! could not find opencode-windows-x64.zip in latest release"; exit 1; }
    zip=$(mktemp /tmp/opencode-sidecar.XXXXXX.zip)
    tmp=$(mktemp -d /tmp/opencode-sidecar-extract.XXXXXX)
    curl -fsSL "$url" -o "$zip"
    unzip -oq "$zip" -d "$tmp"
    mv "$tmp/opencode.exe" "$SIDEcar"
    rm -rf "$zip" "$tmp"
    echo ">> sidecar ready:"
    "$SIDEcar" --version
}

build_one() {
    # $2 = nobundle skips packaging (portable zips only need the exe);
    # $3 = optional bundle types override, e.g. "nsis"
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
        [ -f "$SIDEcar" ] || { echo "!! sidecar missing, run setup first"; exit 1; }
        npm run tauri dev
        ;;
    build)
        for t in $TARGETS; do
            build_one "$t" "" "$BUNDLES"
            # suffix installers so variants don't clobber each other
            bundle="src-tauri/target/release/bundle"
            find "$bundle/nsis" "$bundle/msi" -type f \( -name "*.exe" -o -name "*.msi" \) 2>/dev/null |
                while read -r f; do
                    base="${f%.*}"; ext="${f##*.}"
                    cp "$f" "$bundle/$(basename "$base")-$t.$ext"
                done
            echo ">> [$t] installers in $bundle (*-$t.*)"
        done
        ;;
    portable)
        rel="src-tauri/target/release"
        out="$rel/bundle/portable"
        for t in $TARGETS; do
            build_one "$t" nobundle
            mkdir -p "$out/OpenCode"
            cp "$rel/opencode-gui.exe" "$out/OpenCode/"
            cp "$rel/opencode.exe" "$out/OpenCode/"
            (cd "$out" && zip -qr "opencode-gui-$t-x64.zip" OpenCode)
            echo ">> portable [$t]: $out/opencode-gui-$t-x64.zip"
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
        echo "usage: run.sh [setup|dev|build|portable|check|clean] [win11|win10|both] [bundles] [--version X.Y.Z]"
        exit 1
        ;;
esac
