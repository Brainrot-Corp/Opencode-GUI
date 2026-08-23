#!/usr/bin/env bash
# OpenCode GUI task runner (Linux/WSL/macOS)
# usage:  ./scripts/run.sh <command>
# commands: setup | dev | build | check | clean
set -e
cd "$(dirname "$0")/.."

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

case "${1:-dev}" in
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
        npm run tauri build
        echo ">> installers in src-tauri/target/release/bundle/"
        ;;
    portable)
        npm run tauri build
        rel="src-tauri/target/release"
        out="$rel/bundle/portable"
        mkdir -p "$out/OpenCode"
        cp "$rel/opencode-gui.exe" "$out/OpenCode/"
        cp "$rel/opencode.exe" "$out/OpenCode/"
        (cd "$out" && zip -qr OpenCode-portable-x64.zip OpenCode)
        echo ">> portable: $out/OpenCode-portable-x64.zip"
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
        echo "usage: run.sh [setup|dev|build|portable|check|clean]"
        exit 1
        ;;
esac
