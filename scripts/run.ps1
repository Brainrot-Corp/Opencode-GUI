# OpenCode GUI task runner (Windows)
# usage:  powershell -ExecutionPolicy Bypass -File scripts\run.ps1 <command> [win11|win10|both]
# commands: setup | dev | build | check | clean   (build/portable take a target, default win11)
# win11 = glass build (acrylic), win10 = no-glass build (--features noglass)
param([Parameter(Position = 0)][string]$Cmd = "dev",
      [Parameter(Position = 1)][string]$Target = "win11")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$sidecar = Join-Path $root "src-tauri\binaries\opencode-x86_64-pc-windows-msvc.exe"

switch ($Target) {
    "win11" { $targets = @("win11") }
    "win10" { $targets = @("win10") }
    "both"  { $targets = @("win11", "win10") }
    default { Write-Host "!! target must be win11, win10 or both" -ForegroundColor Red; exit 1 }
}

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

function Build-One([string]$T) {
    Push-Location $root
    if ($T -eq "win10") { npm run tauri build -- --features noglass }
    else { npm run tauri build }
    Pop-Location
    # PS 5.1 doesn't abort on native nonzero exits — check or we'd zip the
    # previous variant's exe under the wrong name
    if ($LASTEXITCODE -ne 0) { Write-Host "!! [$T] build failed" -ForegroundColor Red; exit 1 }
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
        foreach ($t in $targets) {
            Build-One $t
            # suffix installers so variants don't clobber each other
            $bundle = Join-Path $root "src-tauri\target\release\bundle"
            Get-ChildItem $bundle -Recurse -Include *.exe, *.msi |
                Where-Object { $_.Directory.Name -in @("nsis", "msi") } |
                ForEach-Object {
                    Copy-Item $_.FullName (Join-Path $bundle "$($_.BaseName)-$t$($_.Extension)") -Force
                }
            Write-Host ">> [$t] installers in src-tauri\target\release\bundle\ (*-$t.*)"
        }
    }
    "portable" {
        foreach ($t in $targets) {
            Build-One $t
            $rel = Join-Path $root "src-tauri\target\release"
            $out = Join-Path $rel "bundle\portable"
            $stage = Join-Path $out "OpenCode"
            New-Item -ItemType Directory -Force $stage | Out-Null
            Copy-Item (Join-Path $rel "opencode-gui.exe") $stage -Force
            Copy-Item (Join-Path $rel "opencode.exe") $stage -Force
            $zip = Join-Path $out "OpenCode-portable-$t-x64.zip"
            Compress-Archive -Path $stage -DestinationPath $zip -Force
            Write-Host ">> portable [$t]: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
        }
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
        Write-Host "usage: run.ps1 [setup|dev|build|portable|check|clean] [win11|win10|both]"
        exit 1
    }
}
