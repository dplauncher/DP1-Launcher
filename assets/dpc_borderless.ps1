# dpc_borderless.ps1 — external borderless-windowed enforcer for Deadly Premonition.
#
# Why this exists:
#   DPfix's own borderlessFullscreen=1 mode crashes/hangs DP DC on modern
#   Windows 11 + high-DPI + multi-monitor setups (confirmed bug in
#   WindowManager::maintainBorderlessFullscreen — infinite toggle loop).
#   Instead of fighting DPfix, we run DP in plain windowed mode and apply
#   the borderless-fullscreen transformation from outside via Win32 API.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File dpc_borderless.ps1
#       -ProcessName DP -TimeoutSec 60 -PollMs 500
#
# Lifecycle:
#   1. Wait for the named process to start and create a visible main window.
#   2. Pick the monitor the window lives on (where it spawned).
#   3. Strip caption / thick-frame / sysmenu styles → borderless.
#   4. Resize to fill that monitor's rect.
#   5. Loop: re-apply if game resizes the window itself.
#   6. Exit cleanly when the process exits.

param(
    [string]$ProcessName = 'DP',
    [int]   $TimeoutSec  = 60,
    [int]   $PollMs      = 500
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class W {
    public const int GWL_STYLE   = -16;
    public const int GWL_EXSTYLE = -20;

    public const int WS_CAPTION     = 0x00C00000;
    public const int WS_THICKFRAME  = 0x00040000;
    public const int WS_MINIMIZEBOX = 0x00020000;
    public const int WS_MAXIMIZEBOX = 0x00010000;
    public const int WS_SYSMENU     = 0x00080000;
    public const int WS_BORDER      = 0x00800000;
    public const int WS_DLGFRAME    = 0x00400000;

    public const int WS_EX_DLGMODALFRAME = 0x00000001;
    public const int WS_EX_CLIENTEDGE    = 0x00000200;
    public const int WS_EX_STATICEDGE    = 0x00020000;
    public const int WS_EX_WINDOWEDGE    = 0x00000100;

    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_NOZORDER     = 0x0004;
    public const uint SWP_SHOWWINDOW   = 0x0040;
    public const uint SWP_NOACTIVATE   = 0x0010;

    public const uint MONITOR_DEFAULTTONEAREST = 0x00000002;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int  cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll", SetLastError = true)] public static extern int    GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern int    SetWindowLong(IntPtr hwnd, int index, int newStyle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool   SetWindowPos(IntPtr hwnd, IntPtr hwndAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool   GetWindowRect(IntPtr hwnd, out RECT lpRect);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool   GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool   IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool   SetForegroundWindow(IntPtr hwnd);
}
'@ -Language CSharp

# ─── Helpers ───────────────────────────────────────────────────────────────
function Get-DpProcess {
    param([string]$Name)
    # DP DC ships as either DP.exe or DeadlyPremonition.exe depending on build.
    $candidates = @($Name, 'DP', 'DeadlyPremonition')
    foreach ($n in ($candidates | Select-Object -Unique)) {
        $p = Get-Process -Name $n -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($p) { return $p }
    }
    return $null
}

function Apply-Borderless {
    param([IntPtr]$hwnd, [W+MONITORINFO]$mi)
    $mw = $mi.rcMonitor.Right  - $mi.rcMonitor.Left
    $mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top

    $style = [W]::GetWindowLong($hwnd, [W]::GWL_STYLE)
    $style = $style -band -bnot ([W]::WS_CAPTION -bor [W]::WS_THICKFRAME -bor `
                                  [W]::WS_MINIMIZEBOX -bor [W]::WS_MAXIMIZEBOX -bor `
                                  [W]::WS_SYSMENU -bor [W]::WS_BORDER -bor [W]::WS_DLGFRAME)
    [W]::SetWindowLong($hwnd, [W]::GWL_STYLE, $style) | Out-Null

    $exStyle = [W]::GetWindowLong($hwnd, [W]::GWL_EXSTYLE)
    $exStyle = $exStyle -band -bnot ([W]::WS_EX_DLGMODALFRAME -bor [W]::WS_EX_CLIENTEDGE -bor `
                                       [W]::WS_EX_STATICEDGE  -bor [W]::WS_EX_WINDOWEDGE)
    [W]::SetWindowLong($hwnd, [W]::GWL_EXSTYLE, $exStyle) | Out-Null

    $flags = [W]::SWP_FRAMECHANGED -bor [W]::SWP_NOZORDER -bor [W]::SWP_SHOWWINDOW
    [W]::SetWindowPos($hwnd, [IntPtr]::Zero, $mi.rcMonitor.Left, $mi.rcMonitor.Top, $mw, $mh, $flags) | Out-Null
    [W]::SetForegroundWindow($hwnd) | Out-Null
}

# ─── 1. Wait for the game window ───────────────────────────────────────────
$started = Get-Date
$proc = $null
while (-not $proc) {
    $proc = Get-DpProcess -Name $ProcessName
    if (-not $proc) {
        if (((Get-Date) - $started).TotalSeconds -gt $TimeoutSec) {
            Write-Host "[borderless] Timeout — no DP window after ${TimeoutSec}s"
            exit 1
        }
        Start-Sleep -Milliseconds 200
    }
}

$hwnd = $proc.MainWindowHandle
Write-Host ("[borderless] Found DP window hwnd=0x{0:X} pid={1}" -f $hwnd.ToInt64(), $proc.Id)

# Give the game a beat to finish its own window setup before we override.
Start-Sleep -Milliseconds 800

# ─── 2. Snapshot the monitor the game spawned on ──────────────────────────
$mon = [W]::MonitorFromWindow($hwnd, [W]::MONITOR_DEFAULTTONEAREST)
$mi  = New-Object W+MONITORINFO
$mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
[W]::GetMonitorInfo($mon, [ref]$mi) | Out-Null

$mw = $mi.rcMonitor.Right  - $mi.rcMonitor.Left
$mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
Write-Host ("[borderless] Target monitor rect: ({0},{1}) {2}x{3}" -f $mi.rcMonitor.Left, $mi.rcMonitor.Top, $mw, $mh)

# ─── 3. Apply borderless once ──────────────────────────────────────────────
Apply-Borderless -hwnd $hwnd -mi $mi
Write-Host "[borderless] Applied. Watching for window changes…"

# ─── 4. Watch + re-apply if game (or Windows DPI logic) resets the window ─
while ($true) {
    Start-Sleep -Milliseconds $PollMs
    try {
        $p = Get-Process -Id $proc.Id -ErrorAction Stop
    } catch {
        Write-Host "[borderless] DP process exited — done."
        break
    }
    $rect = New-Object W+RECT
    if (-not [W]::GetWindowRect($hwnd, [ref]$rect)) { continue }
    $cw = $rect.Right  - $rect.Left
    $ch = $rect.Bottom - $rect.Top
    if ($cw -ne $mw -or $ch -ne $mh -or $rect.Left -ne $mi.rcMonitor.Left -or $rect.Top -ne $mi.rcMonitor.Top) {
        Write-Host ("[borderless] Window drifted to ({0},{1}) {2}x{3} — re-applying" -f $rect.Left, $rect.Top, $cw, $ch)
        Apply-Borderless -hwnd $hwnd -mi $mi
    }
}
