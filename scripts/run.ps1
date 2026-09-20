# OpenCode GUI task runner (Windows)
# usage:  powershell -ExecutionPolicy Bypass -File scripts\run.ps1 <command> [win11|win10|both] [bundles] [-Version X.Y.Z]
# commands: setup | dev | build | portable | android | check | clean   (build/portable take a target, default win11)
# android = APK build for the mobile companion (needs JDK 17 + ANDROID_HOME + NDK + Developer Mode)
# win11 = glass build (acrylic), win10 = no-glass build (--features noglass)
# build only: 3rd arg picks bundle types (default msi; e.g. "nsis", "msi nsis")
# -Version X.Y.Z bumps the version in tauri.conf.json / Cargo.toml / package.json / package-lock.json first
param([Parameter(Position = 0)][string]$Cmd = "dev",
      [Parameter(Position = 1)][string]$Target = "win11",
      [Parameter(Position = 2)][string]$Bundles = "",
      [string]$Version = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$sidecar = Join-Path $root "src-tauri\binaries\opencode-x86_64-pc-windows-msvc.exe"

if ($Cmd -ne "android") {
    switch ($Target) {
        "win11" { $targets = @("win11") }
        "win10" { $targets = @("win10") }
        "both"  { $targets = @("win10", "win11") } # win11 last ??? it stays staged in OpenCode\
        default { Write-Host "!! target must be win11, win10 or both" -ForegroundColor Red; exit 1 }
    }
}

# bumps the app version in the four files that carry it, before a build
function Set-Version([string]$V) {
    if ($V -notmatch '^\d+(\.\d+){1,2}$') {
        Write-Host "!! invalid version '$V' - use e.g. 1.5.2" -ForegroundColor Red; exit 1
    }
    $enc = New-Object System.Text.UTF8Encoding($false)
    # package-lock.json holds the app version twice, but every dependency has
    # its own "version" too ??? scope the replace to the pair right after the
    # app's own "name" and leave dependencies untouched
    $lockPath = Join-Path $root "package-lock.json"
    $lock = [System.IO.File]::ReadAllText($lockPath)
    $repl = '"name": "opencode-gui",$1"version": "' + $V + '"'
    $lock = $lock -replace '"name": "opencode-gui",([\s\S]*?)"version":\s*"[^"]*"', $repl
    [System.IO.File]::WriteAllText($lockPath, $lock, $enc)

    foreach ($f in @(
        (Join-Path $root "src-tauri\tauri.conf.json"),
        (Join-Path $root "src-tauri\Cargo.toml"),
        (Join-Path $root "package.json")
    )) {
        $text = [System.IO.File]::ReadAllText($f)
        if ($f -like "*Cargo.toml") {
            # anchored to a line start so `tauri = { version = "2" }` is untouched
            $text = $text -replace '(?m)^version = ".*"', "version = `"$V`""
        } else {
            $text = $text -replace '"version":\s*"[^"]*"', "`"version`": `"$V`""
        }
        [System.IO.File]::WriteAllText($f, $text, $enc)
    }
    Write-Host ">> version set to $V in tauri.conf.json, Cargo.toml, package.json, package-lock.json"
}

if ($Version) { Set-Version $Version }

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

# Build-Relay: build the oc-relay companion and stage it where Tauri's
# externalBin expects it (src-tauri\binaries\oc-relay-<triple>) — shipped in
# installers + portable zips so "Run relay on this PC" works out of the box
function Build-Relay {
    Write-Host ">> building oc-relay (notification relay)..."
    Push-Location $root
    cargo build --release --manifest-path relay\Cargo.toml
    Pop-Location
    if ($LASTEXITCODE -ne 0) { Write-Host "!! relay build failed" -ForegroundColor Red; exit 1 }
    $dest = Join-Path $root "src-tauri\binaries\oc-relay-x86_64-pc-windows-msvc.exe"
    Copy-Item (Join-Path $root "relay\target\release\oc-relay.exe") $dest -Force
    Write-Host ">> relay staged: $dest"
}

# Bundle=$false skips packaging (portable zips only need the exe);
# $Bundles optionally overrides bundle types, e.g. "nsis" or "msi nsis"
function Build-One([string]$T, [bool]$Bundle = $true, [string]$Bundles = "") {
    Push-Location $root
    $extra = @()
    if (-not $Bundle) { $extra += "--no-bundle" }
    if ($Bundles) { $extra += @("--bundles", $Bundles) }
    if ($T -eq "win10") { npm run tauri build -- --features noglass @extra }
    else { npm run tauri build -- @extra }
    Pop-Location
    # PS 5.1 doesn't abort on native nonzero exits ??? check or we'd zip the
    # previous variant's exe under the wrong name
    if ($LASTEXITCODE -ne 0) { Write-Host "!! [$T] build failed" -ForegroundColor Red; exit 1 }
}

switch ($Cmd) {
    "setup" {
        Push-Location $root; npm install; Pop-Location
        Fetch-Sidecar
        Build-Relay
        Write-Host ">> setup complete"
    }
    "dev" {
        if (-not (Test-Path $sidecar)) { Write-Host "!! sidecar missing, run setup first" -ForegroundColor Red; exit 1 }
        Push-Location $root; npm run tauri dev; Pop-Location
    }
    "build" {
        Build-Relay
        foreach ($t in $targets) {
            Build-One $t $true $Bundles
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
        Build-Relay
        foreach ($t in $targets) {
            Build-One $t $false
            $rel = Join-Path $root "src-tauri\target\release"
            $out = Join-Path $rel "bundle\portable"
            $stage = Join-Path $out "OpenCode"
            New-Item -ItemType Directory -Force $stage | Out-Null
            Copy-Item (Join-Path $rel "opencode-gui.exe") $stage -Force
            Copy-Item (Join-Path $rel "opencode.exe") $stage -Force
            # relay companion — Tauri externalBin stages it next to the exe; fall back to the staged binaries copy
            $relayExe = Join-Path $rel "oc-relay.exe"
            if (-not (Test-Path $relayExe)) { $relayExe = Join-Path $root "src-tauri\binaries\oc-relay-x86_64-pc-windows-msvc.exe" }
            Copy-Item $relayExe $stage -Force
            $zip = Join-Path $out "opencode-gui-$t-x64.zip"
            Compress-Archive -Path $stage -DestinationPath $zip -Force
            Write-Host ">> portable [$t]: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
        }
    }
    "android" {
        # aarch64 only — the TTS stack (ort-sys) has no armv7/i686 prebuilts and
        # the notification+relay app ships to modern arm64 phones anyway
        Push-Location $root; npm run tauri android build -- --target aarch64; Pop-Location
        if ($LASTEXITCODE -ne 0) { Write-Host "!! android build failed" -ForegroundColor Red; exit 1 }
        $apkDir = Join-Path $root "src-tauri\gen\android\app\build\outputs\apk\universal"
        Get-ChildItem $apkDir -Filter *.apk -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host ">> apk: $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" }
    }
    "check" {
        Push-Location $root; npm run test; Pop-Location
        if ($LASTEXITCODE -ne 0) { Write-Host "!! tests failed" -ForegroundColor Red; exit 1 }
        Push-Location $root; npm run build; Pop-Location
        Push-Location (Join-Path $root "src-tauri"); cargo check; Pop-Location
    }
    "clean" {
        Push-Location (Join-Path $root "src-tauri"); cargo clean; Pop-Location
        Remove-Item (Join-Path $root "dist") -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host ">> cleaned"
    }
    default {
        Write-Host "usage: run.ps1 [setup|dev|build|portable|android|check|clean] [win11|win10|both] [bundles] [-Version X.Y.Z]"
        exit 1
    }
}
