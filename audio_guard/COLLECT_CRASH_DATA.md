# How to collect crash data for DP1 Launcher analysis

If your *Deadly Premonition: The Director's Cut* crashes, you can send us
the crash data to help diagnose what's going wrong. We don't need source
code, debug symbols, or anything sensitive — just where Windows recorded
the crash.

There are 4 places Windows might have stored your crash info. Send
whichever ones you have.

---

## 1. Reliability Monitor (easiest — anyone can do this)

1. Press **Win+R**, type `perfmon /rel`, press Enter
2. The reliability monitor shows a graph of "stability events"
3. Click on any day that has a red ✗ icon
4. In the bottom panel, find the row containing `DP.exe` or `Deadly Premonition`
5. Click **"View technical details"** on the right
6. **Copy the text** (Ctrl+A → Ctrl+C) and paste into a `.txt` file
7. Send that file

What we get from this: faulting module name + offset + exception code.
That's often enough to identify the crash location.

---

## 2. Windows Event Log export

1. Press **Win+R**, type `eventvwr`, press Enter
2. Left sidebar → **Windows Logs** → **Application**
3. Right sidebar → **Filter Current Log...**
4. In the filter dialog:
   - Event sources: **Application Error**, **Application Hang**, **Windows Error Reporting**
   - OK
5. Look through results — find any with `DP.exe` or `Deadly Premonition` in the message
6. Right-click → **Save Selected Events As...** → save as `.evtx`
7. Send that file

Alternative via PowerShell (one-line, easier for tech-savvy users):

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddDays(-30)} |
    Where-Object { $_.Message -like '*DP.exe*' -or $_.Message -like '*Deadly*' } |
    Export-Csv -Path "$env:USERPROFILE\Desktop\dp_crashes.csv" -NoTypeInformation
```

This dumps all DP-related events to a CSV on your desktop.

---

## 3. Crash dump files (.dmp) — the most useful

Windows may have automatically created memory dumps. Check these locations:

### Default location (Windows 10/11)
```
%LocalAppData%\CrashDumps\
```
Open File Explorer → paste this in the address bar → Enter.

Look for files named `DP.exe.<PID>.dmp` or similar. They can be quite
large (50 MB – 2 GB). If you find any:
- ZIP them
- Send the ZIP

### Custom location (if you set up WER LocalDumps via registry)
You'd know if you did this — check the folder you configured.

### Temporary location (if you used Task Manager → Create Dump File)
```
%LocalAppData%\Temp\DP.DMP
```
This file gets overwritten on each new dump, so only the latest is here.

---

## 4. Game logs

These are in the game's install directory:
```
F:\SteamLibrary\steamapps\common\Deadly Premonition The Director's Cut\
    DPfix.log              (DPfix patches log — sometimes useful)
    dp_d3d9.log            (DXVK log — useful if graphics-related)
    DPLauncher_d3d9.log    (DPLauncher DXVK log)
    update.log             (Steam update / patch log)
```

Zip the whole game directory's `*.log` files and send.

---

## What you can OPTIONALLY include (more diagnostic value)

These help us correlate the crash with environmental factors:

### System info via PowerShell
```powershell
$out = "$env:USERPROFILE\Desktop\dp_sysinfo.txt"
"=== GPU ===" | Out-File $out
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion |
    Format-List | Out-File $out -Append
"=== CPU ===" | Out-File $out -Append
Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors |
    Format-List | Out-File $out -Append
"=== Windows ===" | Out-File $out -Append
[System.Environment]::OSVersion.VersionString | Out-File $out -Append
"=== Game install path ===" | Out-File $out -Append
(Get-ChildItem 'C:\Program Files (x86)\Steam\steamapps\libraryfolders.vdf' -ErrorAction SilentlyContinue).FullName | Out-File $out -Append
```

### What was happening at the time of the crash
Just a few sentences:
- Which chapter / scene
- What you were doing (walking, in cutscene, opening menu, etc.)
- Did it crash immediately or hang first?
- Is it reproducible (always at same point)?
- Modern hardware? (RTX 30/40/50? Or older?)
- HDD or SSD?
- Did you use the DP1 launcher? Which version?

---

## To set up automatic future crash collection

This makes Windows save a full dump every time DP.exe crashes:

Open PowerShell **as Administrator**, paste:

```powershell
$key = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\DP.exe"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name "DumpFolder" -Value "$env:USERPROFILE\Desktop\DP_Crashes" -PropertyType ExpandString -Force | Out-Null
New-ItemProperty -Path $key -Name "DumpType"   -Value 2 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $key -Name "DumpCount"  -Value 10 -PropertyType DWord -Force | Out-Null
New-Item -ItemType Directory -Path "$env:USERPROFILE\Desktop\DP_Crashes" -Force | Out-Null
Write-Host "Done. Future DP.exe crashes will be dumped to: $env:USERPROFILE\Desktop\DP_Crashes"
```

After that, just play normally. Any crash auto-creates a `.dmp` file on
your Desktop in `DP_Crashes` folder. ZIP and send.

---

## Privacy note

Crash dumps contain process memory at the moment of crash. They do NOT
contain your save files, account passwords, or browser data. They may
contain:
- The game's loaded DLL list and offsets
- The state of game objects in memory (NPC positions, your character
  position in-game, current chapter/save name, etc.)
- The crashing thread's stack
- Some Windows API state

If you're cautious, you can:
1. Use Windows Defender to scan the .dmp before sending (it's just a file)
2. Skip sending memory dumps and only send Event Log / Reliability Monitor
   data — that's typically enough for crash diagnosis
