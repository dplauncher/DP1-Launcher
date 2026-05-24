# DPC Codec Watcher
#
# Lowers DirectShow merit of LAV Filters (registered by K-Lite Codec Pack)
# so that Microsoft's native WMV/VC-1 decoders win the filter graph race
# during cutscene playback in Deadly Premonition. Without this, LAV's WMV
# decoder is preferred and can crash the game on Windows 11 + RTX 50-series.
#
# The patch is SESSION-SCOPED:
#   1. On start: read each LAV filter's FilterData blob, back up to memory,
#      and rewrite the merit field (bytes 4..7) to MERIT_DO_NOT_USE (0x200000).
#   2. Wait up to -MaxWaitSec for DP.exe to start. If it never starts,
#      restore immediately.
#   3. While DP.exe runs, sit idle.
#   4. When DP.exe exits (or this script is killed via finally), restore
#      every FilterData blob byte-for-byte from the in-memory backup.
#
# Filter Category GUID for "DirectShow Filters" in registry:
#   {083863F1-70DE-11D0-BD40-00A0C911CE86}
#
# Standard DirectShow merit values:
#   MERIT_PREFERRED   = 0x800000
#   MERIT_NORMAL      = 0x600000  ← LAV registers around here
#   MERIT_UNLIKELY    = 0x400000
#   MERIT_DO_NOT_USE  = 0x200000  ← what we write
#
# Run with admin privileges (HKLM write).
#
# Usage:
#   powershell.exe -File dpc_codec_watcher.ps1 `
#       -ProcessName DP `
#       -BackupFile  "$env:APPDATA\DP1Launcher\codec-session-backup.json"

param(
    [string]$ProcessName    = 'DP',
    [int]$MaxWaitSec        = 60,
    [string]$BackupFile     = "$env:APPDATA\DP1Launcher\codec-session-backup.json"
)

$ErrorActionPreference = 'Continue'

# Known LAV Filters CLSIDs (K-Lite default install).
$LAV_CLSIDS = @(
    '{EE30215D-164F-4A92-A4EB-9D4C13390F9F}',  # LAV Video Decoder
    '{E8E73B6B-4CB3-44A4-BE99-4F7BCB96E491}',  # LAV Audio Decoder
    '{171252A0-8820-4AFE-9DF8-5C92B2D66B04}',  # LAV Splitter
    '{B98D13E7-55DB-4385-A33D-09FD1BA26339}'   # LAV Splitter Source
)
$CATEGORY = '{083863F1-70DE-11D0-BD40-00A0C911CE86}'

function Get-FilterPath([string]$clsid) {
    "HKLM:\SOFTWARE\Classes\CLSID\$CATEGORY\Instance\$clsid"
}

function Read-FilterData([string]$clsid) {
    $p = Get-FilterPath $clsid
    if (-not (Test-Path $p)) { return $null }
    try {
        return (Get-ItemProperty -Path $p -Name 'FilterData' -ErrorAction Stop).FilterData
    } catch { return $null }
}

function Write-FilterData([string]$clsid, [byte[]]$data) {
    $p = Get-FilterPath $clsid
    if (-not (Test-Path $p)) { return $false }
    try {
        Set-ItemProperty -Path $p -Name 'FilterData' -Value $data -Type Binary -ErrorAction Stop
        return $true
    } catch { return $false }
}

function Save-Backup([hashtable]$backup) {
    $dir = Split-Path -Parent $BackupFile
    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
    $serialized = @{}
    foreach ($k in $backup.Keys) { $serialized[$k] = [Convert]::ToBase64String($backup[$k]) }
    $serialized | ConvertTo-Json | Set-Content -Path $BackupFile -Encoding UTF8
}

function Load-Backup() {
    if (-not (Test-Path $BackupFile)) { return @{} }
    try {
        $json = Get-Content -Path $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $h = @{}
        $json.PSObject.Properties | ForEach-Object { $h[$_.Name] = [Convert]::FromBase64String($_.Value) }
        return $h
    } catch { return @{} }
}

function Remove-BackupFile() {
    if (Test-Path $BackupFile) { Remove-Item -Path $BackupFile -Force -ErrorAction SilentlyContinue }
}

# ── If a stale backup exists (previous run died), restore from it first ──
$staleBackup = Load-Backup
if ($staleBackup.Count -gt 0) {
    foreach ($clsid in $staleBackup.Keys) {
        Write-FilterData $clsid $staleBackup[$clsid] | Out-Null
    }
    Remove-BackupFile
}

# ── Phase 1: read current merits & patch to MERIT_DO_NOT_USE ──
$backup = @{}
foreach ($clsid in $LAV_CLSIDS) {
    $data = Read-FilterData $clsid
    if ($null -ne $data -and $data.Length -ge 8) {
        # Save original bytes
        $backup[$clsid] = $data.Clone()
        # Build patched copy with merit = 0x00200000 (little-endian)
        $patched = $data.Clone()
        $patched[4] = 0x00
        $patched[5] = 0x00
        $patched[6] = 0x20
        $patched[7] = 0x00
        Write-FilterData $clsid $patched | Out-Null
    }
}

if ($backup.Count -eq 0) {
    # No LAV filters found — nothing to do.
    exit 0
}

# Persist backup so a kill -9 or reboot can still restore via launcher
Save-Backup $backup

# ── Phase 2: wait for DP.exe to start ──
$deadline = (Get-Date).AddSeconds($MaxWaitSec)
$gameProc = $null
while ((Get-Date) -lt $deadline) {
    $gameProc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($gameProc) { break }
    Start-Sleep -Milliseconds 250
}

try {
    if ($gameProc) {
        # ── Phase 3: wait until the game exits ──
        try { $gameProc.WaitForExit() } catch {}
    }
} finally {
    # ── Phase 4: restore originals byte-for-byte ──
    foreach ($clsid in $backup.Keys) {
        Write-FilterData $clsid $backup[$clsid] | Out-Null
    }
    Remove-BackupFile
}
