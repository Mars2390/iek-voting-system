<#
.SYNOPSIS
    Verifies a Windows machine is ready for Flutter development on Engineer Hub.

.DESCRIPTION
    Runs a series of read-only checks (nothing is installed or modified) and
    prints a PASS/FAIL summary. Exits with code 1 if any required check fails,
    so it can be dropped into CI or a setup script later.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\docs\flutter\verify-flutter-setup.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

$script:Results = @()

function Add-Result {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][bool]$Passed,
        [string]$Detail = '',
        [bool]$Required = $true
    )
    $script:Results += [pscustomobject]@{
        Name     = $Name
        Passed   = $Passed
        Detail   = $Detail
        Required = $Required
    }

    if ($Passed) {
        Write-Host "  [PASS] $Name" -ForegroundColor Green
    }
    elseif ($Required) {
        Write-Host "  [FAIL] $Name" -ForegroundColor Red
    }
    else {
        Write-Host "  [WARN] $Name" -ForegroundColor Yellow
    }

    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
}

function Test-CommandExists {
    param([Parameter(Mandatory)][string]$Command)
    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host '=== Engineer Hub :: Flutter setup verification ===' -ForegroundColor Cyan
Write-Host ''

# --- 1. Core tooling on PATH ------------------------------------------------
Write-Host 'Tooling' -ForegroundColor Cyan

$hasGit = Test-CommandExists 'git'
Add-Result -Name 'Git is on PATH' -Passed $hasGit `
    -Detail $(if ($hasGit) { (git --version) } else { 'Install from https://git-scm.com/download/win' })

$hasFlutter = Test-CommandExists 'flutter'
if ($hasFlutter) {
    $flutterVersion = (flutter --version 2>&1 | Select-Object -First 1)
    Add-Result -Name 'Flutter is on PATH' -Passed $true -Detail $flutterVersion
}
else {
    Add-Result -Name 'Flutter is on PATH' -Passed $false `
        -Detail 'Add <flutter-sdk>\bin to your User PATH, then open a NEW terminal.'
}

$hasDart = Test-CommandExists 'dart'
Add-Result -Name 'Dart is on PATH' -Passed $hasDart -Required $false `
    -Detail 'Bundled with Flutter; only missing if PATH is partial.'

$hasAdb = Test-CommandExists 'adb'
Add-Result -Name 'adb (Android platform-tools) is on PATH' -Passed $hasAdb -Required $false `
    -Detail 'Optional, but handy. Add %LOCALAPPDATA%\Android\Sdk\platform-tools to PATH.'

# --- 2. Flutter doctor ------------------------------------------------------
Write-Host ''
Write-Host 'flutter doctor' -ForegroundColor Cyan

if ($hasFlutter) {
    $doctor = (flutter doctor 2>&1 | Out-String)
    Write-Host $doctor -ForegroundColor DarkGray

    Add-Result -Name 'Flutter SDK check' -Passed ($doctor -match '\[.\] Flutter')
    # A healthy line looks like "[OK] Android toolchain - develop for Android devices".
    # Flutter marks problems with X or ! and appends an explanation, so treat the
    # absence of those markers on the Android line as a pass.
    $androidLine = ($doctor -split "`r?`n" | Where-Object { $_ -match 'Android toolchain' } | Select-Object -First 1)
    $androidOk = ([bool]$androidLine) -and ($androidLine -notmatch '^\s*\[\s*(X|x|!)\s*\]')
    Add-Result -Name 'Android toolchain (SDK + licenses)' -Passed $androidOk `
        -Detail $(if ($androidOk) { $androidLine.Trim() } else { 'Run: flutter doctor --android-licenses' })

    $hasVsCodeEntry = $doctor -match 'VS Code'
    Add-Result -Name 'VS Code detected by Flutter' -Passed $hasVsCodeEntry -Required $false

    if ($doctor -match 'cmdline-tools component is missing') {
        Add-Result -Name 'Android SDK command-line tools installed' -Passed $false `
            -Detail 'Android Studio > SDK Manager > SDK Tools > "Android SDK Command-line Tools (latest)"'
    }
    if ($doctor -match 'Android license status unknown|licenses not accepted') {
        Add-Result -Name 'Android licenses accepted' -Passed $false `
            -Detail 'Run: flutter doctor --android-licenses  (press y for each)'
    }
}
else {
    Add-Result -Name 'flutter doctor ran' -Passed $false -Detail 'Flutter not on PATH — skipped.'
}

# --- 3. VS Code extensions --------------------------------------------------
Write-Host ''
Write-Host 'VS Code extensions' -ForegroundColor Cyan

if (Test-CommandExists 'code') {
    $extensions = (code --list-extensions 2>&1 | Out-String)
    Add-Result -Name 'Dart extension (Dart-Code.dart-code)' `
        -Passed ($extensions -match 'Dart-Code\.dart-code') `
        -Detail 'Install: code --install-extension Dart-Code.dart-code'
    Add-Result -Name 'Flutter extension (Dart-Code.flutter)' `
        -Passed ($extensions -match 'Dart-Code\.flutter') `
        -Detail 'Install: code --install-extension Dart-Code.flutter'
}
else {
    Add-Result -Name 'VS Code CLI (code) on PATH' -Passed $false -Required $false `
        -Detail 'Reinstall VS Code with "Add to PATH" ticked, or check extensions manually.'
}

# --- 4. Emulator / devices --------------------------------------------------
Write-Host ''
Write-Host 'Devices' -ForegroundColor Cyan

if ($hasFlutter) {
    $devices = (flutter devices 2>&1 | Out-String)
    Write-Host $devices -ForegroundColor DarkGray
    $noDevices = $devices -match 'No devices|no authorised devices'
    Add-Result -Name 'At least one device/emulator available' -Passed (-not $noDevices) `
        -Detail 'Start an AVD from Android Studio > Device Manager, then re-run.'
}

$emulatorExe = Join-Path $env:LOCALAPPDATA 'Android\Sdk\emulator\emulator.exe'
if (Test-Path $emulatorExe) {
    $avds = (& $emulatorExe -list-avds 2>&1 | Out-String).Trim()
    Add-Result -Name 'Android Virtual Device (AVD) created' -Passed ([bool]$avds) `
        -Detail $(if ($avds) { "AVDs: $($avds -replace '\r?\n', ', ')" } else { 'Create one in Android Studio > Device Manager.' })
}
else {
    Add-Result -Name 'Android emulator installed' -Passed $false -Required $false `
        -Detail "Not found at $emulatorExe — Android SDK may be in a custom location."
}

# --- 5. Virtualisation (emulator performance) -------------------------------
Write-Host ''
Write-Host 'Hardware acceleration' -ForegroundColor Cyan

try {
    $cpuVirt = (Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).HypervisorPresent
    $vmFirmware = (Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1).VirtualizationFirmwareEnabled
    Add-Result -Name 'CPU virtualisation available' -Passed ([bool]($cpuVirt -or $vmFirmware)) -Required $false `
        -Detail 'If false, enable VT-x / AMD-V (SVM) in your BIOS/UEFI. Emulator will be very slow without it.'
}
catch {
    Add-Result -Name 'CPU virtualisation check' -Passed $false -Required $false -Detail $_.Exception.Message
}

# --- 6. Developer Mode (needed for plugin symlinks) -------------------------
$devModeKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
$devMode = (Get-ItemProperty -Path $devModeKey -Name AllowDevelopmentWithoutDevLicense -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense
Add-Result -Name 'Windows Developer Mode enabled' -Passed ($devMode -eq 1) -Required $false `
    -Detail 'Needed for plugin symlink support. Enable: start ms-settings:developers'

# --- 7. Engineer Hub API reachability ---------------------------------------
Write-Host ''
Write-Host 'Engineer Hub API' -ForegroundColor Cyan

try {
    $response = Invoke-WebRequest -Uri 'https://www.engineerhuub.com/api/election-status' `
        -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    Add-Result -Name 'https://www.engineerhuub.com/api/election-status reachable' `
        -Passed ($response.StatusCode -eq 200) -Required $false `
        -Detail "HTTP $($response.StatusCode)"
}
catch {
    Add-Result -Name 'Engineer Hub API reachable' -Passed $false -Required $false `
        -Detail $_.Exception.Message
}

# --- Summary ----------------------------------------------------------------
Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan

$failedRequired = @($script:Results | Where-Object { -not $_.Passed -and $_.Required })
$warned         = @($script:Results | Where-Object { -not $_.Passed -and -not $_.Required })
$passed         = @($script:Results | Where-Object { $_.Passed })

Write-Host ("  Passed:   {0}" -f $passed.Count)          -ForegroundColor Green
Write-Host ("  Warnings: {0}" -f $warned.Count)          -ForegroundColor Yellow
Write-Host ("  Failed:   {0}" -f $failedRequired.Count)  -ForegroundColor Red

if ($failedRequired.Count -gt 0) {
    Write-Host ''
    Write-Host 'Required checks that failed:' -ForegroundColor Red
    $failedRequired | ForEach-Object { Write-Host "  - $($_.Name): $($_.Detail)" -ForegroundColor Red }
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host 'Environment is ready for Flutter development.' -ForegroundColor Green
Write-Host ''
exit 0
