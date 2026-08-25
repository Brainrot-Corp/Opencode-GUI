#!/usr/bin/env bash
# OpenCode GUI task runner (Linux/WSL/macOS)
# usage:  ./scripts/run.sh <command> [win11|win10|both]
# commands: setup | dev | build | check | clean   (build/portable take a target, default both)
# win11 = glass build (Mica), win10 = no-glass build (--no-default-features)
set -e
cd "$(dirname "$0")/.."

CMD="${1:-dev}"
TARGET="${2:-both}"
case "$TARGET" in
    win11) TARGETS="win11" ;;
    win10) TARGETS="win10" ;;
    both)  TARGETS="win11 win10" ;;
    *) echo "!! target must be win11, win10 or both"; exit 1 ;;
esac

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
    if [ "$1" = "win10" ]; then
        npm run tauri build -- --no-default-features
    else
        npm run tauri build
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
            build_one "$t"
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
            build_one "$t"
            mkdir -p "$out/OpenCode"
            cp "$rel/opencode-gui.exe" "$out/OpenCode/"
            cp "$rel/opencode.exe" "$out/OpenCode/"
            (cd "$out" && zip -qr "OpenCode-portable-$t-x64.zip" OpenCode)
            echo ">> portable [$t]: $out/OpenCode-portable-$t-x64.zip"
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
        echo "usage: run.sh [setup|dev|build|portable|check|clean] [win11|win10|both]"
        exit 1
        ;;
esac
