# DPC Cursor Hide Watcher (persistent)
#
# Runs indefinitely until killed by the launcher. Continuously polls for
# DP.exe, hides cursor while DP.exe is the foreground window, leaves it
# alone otherwise, and survives game restarts (game exits → back to
# polling for next game launch).
#
# Why aggressive:
#   While the game window loses focus (Alt-Tab), DP.exe's main loop
#   keeps calling ShowCursor(1) every frame as long as its internal
#   condition is met. Over a few seconds of Alt-Tab that can add 60-200
#   to the counter. To overcome that on focus-regain we decrement up to
#   1000 times per poll and poll every 60 ms.
#
# Diagnostic log: %APPDATA%\dp1-launcher\cursor-hide.log

param(
    [string]$ProcessName = 'DP',
    [int]$PollMs = 60,
    [string]$LogFile = "$env:APPDATA\dp1-launcher\cursor-hide.log"
)

$ErrorActionPreference = 'SilentlyContinue'

# Ensure log dir exists & truncate/rotate log if it got large
try {
    $logDir = Split-Path -Parent $LogFile
    if (-not (Test-Path $logDir)) { New-Item -Path $logDir -ItemType Directory -Force | Out-Null }
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 256KB)) {
        Set-Content -Path $LogFile -Value '' -Encoding UTF8
    }
} catch {}

function Write-Log([string]$msg) {
    try {
        $stamp = (Get-Date).ToString('HH:mm:ss.fff')
        Add-Content -Path $LogFile -Value "$stamp  $msg" -Encoding UTF8
    } catch {}
}

Write-Log "=== cursor-hide watcher start (pid=$PID, processName=$ProcessName, poll=${PollMs}ms) ==="

try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'AboveNormal' } catch {}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W32 {
    [DllImport("user32.dll")]                                public static extern int     ShowCursor(bool show);
    [DllImport("user32.dll")]                                public static extern IntPtr  GetForegroundWindow();
    [DllImport("user32.dll", SetLastError=true)]             public static extern uint    GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]                                public static extern bool    AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")]                              public static extern uint    GetCurrentThreadId();

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO {
        public int    cbSize;
        public int    flags;
        public IntPtr hCursor;
        public POINT  ptScreenPos;
    }
    [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
    public const int CURSOR_SHOWING = 0x00000001;
}
"@

function Test-CursorVisible {
    $ci = New-Object W32+CURSORINFO
    $ci.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($ci)
    if (-not [W32]::GetCursorInfo([ref]$ci)) { return $true }
    return ($ci.flags -band [W32]::CURSOR_SHOWING) -ne 0
}

function Hide-CursorAggressive([uint32]$dpTid) {
    $myTid = [W32]::GetCurrentThreadId()
    if ($dpTid -eq 0 -or $dpTid -eq $myTid) { return -1 }
    [W32]::AttachThreadInput($myTid, $dpTid, $true) | Out-Null
    $iters = 0
    for ($i = 0; $i -lt 1000; $i++) {
        $c = [W32]::ShowCursor($false)
        $iters++
        if ($c -lt 0) { break }
    }
    [W32]::AttachThreadInput($myTid, $dpTid, $false) | Out-Null
    return $iters
}

function Restore-Cursor([uint32]$dpTid) {
    $myTid = [W32]::GetCurrentThreadId()
    if ($dpTid -eq 0 -or $dpTid -eq $myTid) { return }
    [W32]::AttachThreadInput($myTid, $dpTid, $true) | Out-Null
    for ($i = 0; $i -lt 1000; $i++) {
        $c = [W32]::ShowCursor($true)
        if ($c -ge 0) { break }
    }
    [W32]::AttachThreadInput($myTid, $dpTid, $false) | Out-Null
}

# ── Outer loop: persistent across game restarts ────────
$lastGamePid = 0
$lastHiddenTid = 0

while ($true) {
    try {
        # Find game process (polled every 1s while waiting)
        $gameProc = $null
        while (-not $gameProc) {
            $gameProc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $gameProc) { Start-Sleep -Milliseconds 1000 }
        }

        if ($gameProc.Id -ne $lastGamePid) {
            Write-Log "game found: pid=$($gameProc.Id)"
            $lastGamePid = $gameProc.Id
        }

        $gamePid = $gameProc.Id
        $tickCount = 0

        # Inner loop: while game alive
        while (-not $gameProc.HasExited) {
            $hwnd = [W32]::GetForegroundWindow()
            $fgPid = 0
            $fgTid = [W32]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)

            if ($fgPid -eq $gamePid) {
                if (Test-CursorVisible) {
                    $n = Hide-CursorAggressive $fgTid
                    if ($tickCount % 50 -eq 0) {
                        Write-Log "hide tid=$fgTid iters=$n  (still visible? $(Test-CursorVisible))"
                    }
                }
                $lastHiddenTid = $fgTid
            }

            $tickCount++
            Start-Sleep -Milliseconds $PollMs
            $gameProc.Refresh()
        }

        Write-Log "game exited (pid=$lastGamePid). returning to wait state."
        if ($lastHiddenTid -ne 0) { Restore-Cursor $lastHiddenTid; $lastHiddenTid = 0 }
        $lastGamePid = 0
    }
    catch {
        Write-Log "ERROR in outer loop: $_"
        Start-Sleep -Milliseconds 1000
    }
}
