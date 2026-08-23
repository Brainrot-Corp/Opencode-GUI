# OpenCode GUI task runner (Windows)
# usage:  powershell -ExecutionPolicy Bypass -File scripts\run.ps1 <command>
# commands: setup | dev | build | check | clean
param([Parameter(Position = 0)][string]$Cmd = "dev")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$sidecar = Join-Path $root "src-tauri\binaries\opencode-x86_64-pc-windows-msvc.exe"

function Fetch-Sidecar {
    $dest = Join-Path $root "src-tauri\binaries"
    New-Item -ItemType Directory -Force $dest | Out-Null
    Write-Host ">> fetching latest opencode windows binary..."
    $rel = Invoke-RestMethod "https://api.github.com/repos/anomalyco/opencode/releases/latest"
    $asset = $rel.assets | Where-Object { $_.name -eq "opencode-windows-x64.zip" }
    if (-not $asset) { throw "could not find opencode-windows-x64.zip in latest release" }
    $zip = Join-Path $env:TEMP "opencode-sidecar.zip"
    $tmp = Join-Path $env:TEMP "opencode-sidecar-extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip
    Expand-Archive $zip $tmp -Force
    Move-Item (Join-Path $tmp "opencode.exe") $sidecar -Force
    Remove-Item $zip, $tmp -Recurse -Force
    Write-Host ">> sidecar ready:"
    & $sidecar --version
}

switch ($Cmd) {
    "setup" {
        Push-Location $root; npm install; Pop-Location
        Fetch-Sidecar
        Write-Host ">> setup complete"
    }
    "dev" {
        if (-not (Test-Path $sidecar)) { Write-Host "!! sidecar missing, run setup first" -ForegroundColor Red; exit 1 }
        Push-Location $root; npm run tauri dev; Pop-Location
    }
    "build" {
        Push-Location $root; npm run tauri build; Pop-Location
        Write-Host ">> installers in src-tauri\target\release\bundle\"
    }
    "portable" {
        Push-Location $root; npm run tauri build; Pop-Location
        $rel = Join-Path $root "src-tauri\target\release"
        $out = Join-Path $rel "bundle\portable"
        $stage = Join-Path $out "OpenCode"
        New-Item -ItemType Directory -Force $stage | Out-Null
        Copy-Item (Join-Path $rel "opencode-gui.exe") $stage -Force
        Copy-Item (Join-Path $rel "opencode.exe") $stage -Force
        Compress-Archive -Path $stage -DestinationPath (Join-Path $out "OpenCode-portable-x64.zip") -Force
        Write-Host ">> portable: $out\OpenCode-portable-x64.zip ($([math]::Round((Get-Item (Join-Path $out 'OpenCode-portable-x64.zip')).Length / 1MB, 1)) MB)"
    }
    "check" {
        Push-Location $root; npm run build; Pop-Location
        Push-Location (Join-Path $root "src-tauri"); cargo check; Pop-Location
    }
    "clean" {
        Push-Location (Join-Path $root "src-tauri"); cargo clean; Pop-Location
        Remove-Item (Join-Path $root "dist") -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host ">> cleaned"
    }
    default {
        Write-Host "usage: run.ps1 [setup|dev|build|portable|check|clean]"
        exit 1
    }
}
