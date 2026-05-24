# Why "Smoking a Cigarette" Fixes Crashes in Deadly Premonition

> A reverse-engineering write-up of the FPS-dependent timing bug in
> Deadly Premonition: The Director's Cut (PC, 2013), and why locking
> the game to 60 FPS eliminates the entire class of crashes that the
> community has been working around with in-game smoking for over a
> decade.

## TL;DR

- The PC port of DPC has a **deterministic** crash pattern: certain
  saves at certain in-game times reliably crash the game during specific
  cutscenes (Chapter 8 gas station, Chapter 9 diner, "seven bones"
  cutscenes, etc.).
- The community workaround is to **smoke a cigarette in-game** to
  advance time by an hour, which makes the same cutscene play cleanly.
- We reverse-engineered `DP.exe` and found the root cause: the
  delta-time computation in the main loop uses `ceil()` rounding, which
  is mathematically correct **only at 30/60/120 FPS**. At any other
  framerate (e.g. 144 Hz on a modern monitor), the in-game clock drifts
  faster than real time and the scripted state-machine eventually
  triggers cutscenes in an inconsistent state → crash.
- The fix is mundane: **cap the framerate to 60 FPS** in your GPU
  driver. This launcher detects your GPU and opens the right control
  panel for you, with step-by-step instructions.

## The community report we trust

From a Steam community post (full quote in repo issues):

> Throughout the game when dealing with consistent crashes in specific
> places, fast-forwarding time with cigarettes can prevent crashes.
> Chapter 9 is notorious for being one of the worst offenders... In
> Chapter 9, after Olivia gives York the "Key to Back Yard" in the
> diner, it is common for the game to crash during the cutscene
> outside, right after York says, "Let's hope it's not just something
> for the gossip columns". Many users have reported that smoking a
> cigarette (in-game) in the diner for an hour or two (about 13:00)
> before leaving the diner will help prevent the crash.

Important details:

- Crashes are **deterministic**: same save + same in-game time = same
  crash, every time.
- Both **smoking** (~1 in-game hour) and **sleeping** (~3 in-game
  hours) prevent the crash → the trick isn't smoking specifically, it's
  **advancing the in-game clock past a broken state**.
- Crashes are tied to **cutscenes** specifically — both fully-rendered
  in-engine cutscenes and `.wmv` overlay scenes.

## Reverse engineering process

The PC port of DPC has no public source. We disassembled `DP.exe`
(1.01b, build timestamp 2013-11-28) using Ghidra and traced the
main-loop frame timing logic.

### Key functions identified

| Function | Address (VA) | Role |
| -------- | ------------ | ---- |
| `FUN_00700650` | `0x00700650` | `WinMain` / main message loop (game's WinProc) |
| `FUN_00701040` | `0x00701040` | Timer source — wraps `QueryPerformanceCounter` |
| `FUN_0041c270` | `0x0041c270` | **Selector**: returns bit 31 of `DAT_008a6074`, picks delta-time formula |
| `FUN_00752410` | `0x00752410` | `ceil()` — math runtime helper |
| `FUN_00751920` | `0x00751920` | `floor()` — math runtime helper |
| `FUN_00642640` | `0x00642640` | ~3000-line state machine — game's event/scene logic |

### The delta-time formula

Inside the main loop:

```c
local_230 = 60.0;
// ...
float delta = (now_seconds - last_seconds) * local_230;  // raw delta in "60-Hz ticks"
if (delta >= 8.0) delta = 8.0;                            // clamp

uint32 mode = FUN_0041c270();   // 0 or 1, depending on game state

if (mode == 0) {
    delta = ceil(delta);          // Path A — DEFAULT (bit 31 of DAT_008a6074 = 0)
    if (delta > 8.0) delta = 8.0;
}
else {
    delta = floor(delta) + residual_accumulator;  // Path B — fixed-step
}

_DAT_014affe0 = delta;            // global delta consumed by all game systems
```

### The bug

Path A's `ceil(delta)` is **only stable at integer-delta framerates**:

| Real FPS | Raw delta | ceil(delta) | Effective speed |
| -------- | --------- | ----------- | --------------- |
| 30 | 2.0 | 2.0 | **1.0×** (correct) |
| 60 | 1.0 | 1.0 | **1.0×** (correct) |
| 120 | 0.5 | 1.0 | **2.0×** too fast |
| 144 | 0.417 | 1.0 | **2.4×** too fast |
| 240 | 0.25 | 1.0 | **4.0×** too fast |

At any framerate that doesn't divide evenly into 60, the in-game clock
advances faster than real time. NPC schedules drift out of sync,
scripted events trigger between valid state windows, and cutscenes
execute against a partially-loaded world → null deref → crash.

### Why smoking fixes it

Smoking is a scripted time-jump event. It forces:

1. The world clock advances by a fixed in-game amount (1-2 hours).
2. The NPC scheduler re-evaluates routes from scratch for the new
   time.
3. All time-gated scripted events are re-anchored to the new clock.

Effectively it brute-forces past the broken transition window.

### Why the hex-patch fix didn't work

We initially tried patching `FUN_0041c270` to always return `1` — i.e.
forcing Path B (`floor` + residual accumulator) everywhere. This is
mathematically correct at any framerate. But Path B has its own
problem: at 144 FPS the per-frame delta is `floor(0.417) = 0` for two
out of three frames, with a `+1.0` jump on the third frame. This
produces **visible stuttering in car physics** (the user clearly
reported the regression during testing).

The engine's dynamic A/B switching exists precisely because each path
is good for different game systems — Path A for smooth visuals, Path B
for accurate timing — but the switching logic is incomplete and the
default mode is broken at FPS > 60.

## The fix that actually works

Cap the framerate to **60 FPS** at the driver level. At 60 FPS:

- Raw delta = 1.0 per frame
- `ceil(1.0) == floor(1.0) == 1.0` — both paths produce the same value
- No drift, no stutter
- Scripts trigger when expected
- Cutscenes play cleanly

This matches the engine's original Xbox 360 target frame rate (30 FPS,
which also gives integer delta: 2.0 per frame).

DXVK has a `dxvk.maxFrameRate` config option but it's unreliable on
Win 11 + VRR setups. The most authoritative path is the GPU vendor's
driver-level cap:

- **NVIDIA**: Control Panel → Manage 3D Settings → Program Settings →
  `DeadlyPremonition.exe` → Max Frame Rate → 60
- **AMD**: Adrenalin → Gaming → `DeadlyPremonition.exe` → Frame Rate
  Target Control → 60
- **Intel**: Graphics Command Center → Games → `DeadlyPremonition` →
  Frame Rate Target → 60

The launcher detects your GPU and opens the right panel with the exact
clicks needed.

## What this means for the community

The smoking workaround is **folk knowledge for "advance time past a
broken state"**. With the FPS cap in place, the broken state never
arises, and smoking is no longer needed as a crash mitigation. (It
remains a fun in-game mechanic, of course.)

If you still see crashes at 60 FPS after a clean playthrough:

- Cutscene crash specifically → likely a DirectShow codec issue. The
  launcher's "Codec Fix" toggle session-locks LAV Filters merit so
  Microsoft's native WMV decoder wins. K-Lite Codec Pack is the usual
  culprit.
- Random crash after long sessions → 32-bit address space
  fragmentation. The 4 GB Large-Address-Aware patch (also in the
  launcher) reduces this; a reboot clears the rest.
- Chapter 9 end-of-chapter save corruption → known engine bug,
  unrelated to timing. The launcher's autosave-backup snapshots the
  save every 2 minutes so you can roll back.

## Credits & references

- **Peter "Durante" Thoman** — original DPfix (d3d9 wrapper, fixed
  resolution, AA, shadows). Without DPfix the game was essentially
  unplayable on PC; our reverse engineering builds on his work.
- **PCGamingWiki** — documented the smoking workaround and other
  crash mitigations for years.
- **Steam community thread** by Erroneous Syntax / Dengarde /
  Zeddikins (Oct 2013) — partial save-format reverse engineering
  (character byte at offset `0x5CA`, etc.).
- The DPC community on Reddit and Steam — for keeping this 13-year-old
  game alive and documented.

## Reproducibility

If you want to verify the fix yourself:

1. Apply NVIDIA / AMD / Intel cap at 60 FPS for `DP.exe`.
2. Load a save just before the Chapter 9 diner cutscene with Olivia.
3. Walk out without smoking, watch the cutscene with York saying
   "Let's hope it's not just something for the gossip columns."
4. Without the cap, this cutscene crashes for many users. With the
   cap, it should play cleanly.

If your result differs (or matches), please open an issue with your
GPU, driver version, monitor refresh rate, and a copy of the save file.

---

*This document is part of the DP1 Launcher project — a community
launcher for Deadly Premonition: The Director's Cut with Ukrainian
localization and aggregated PC fixes.*
