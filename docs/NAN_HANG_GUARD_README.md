# NaN Hang Guard — User-Facing README

> A user-friendly companion to [`NAN_HANG_GUARD.md`](./NAN_HANG_GUARD.md) (the
> deep RE writeup). This file answers "what is it, is it safe, how do I use it".

## What is this?

A **2-byte fix** for one specific way *Deadly Premonition: The Director's Cut*
can hang on Windows. Found by analyzing a real Task Manager dump from the
Chapter 3 hospital scene, where the game gets stuck with "Not Responding" in
the title bar and you have to End Task.

## What bug does it fix?

Inside `DP.exe` there's a math function that does this when its input is
invalid:

```
00409EA6  EB FE     jmp 00409EA6     ← jumps to itself, forever
```

That's a `while (true);` loop — an internal "this can never happen" guard.
Except it does happen. When the game feeds it a NaN ("not a number" float
value, produced by divisions by zero in animation/camera math during scripted
transitions), the main thread enters this loop and never returns.

Result: game freezes, no error, no crash dialog — just hangs.

## What does the patch do?

It changes those 2 bytes from `EB FE` (jump to self) to `90 90` (two NOPs —
no-operation). The function then naturally falls through to the existing
"safe path" right below, which loads `0.0f` and returns.

In plain English: **instead of hanging forever on invalid input, the function
now returns zero**. The game might glitch slightly (a frame of weird camera
or animation) but it keeps running.

## Is it safe?

**Yes, with reasonable safeguards:**

* The patch is **exactly 2 bytes**. The rest of `DP.exe` is byte-identical to
  the Steam version. A `git diff` would show one line changed.
* The launcher refuses to patch unless it finds the exact pattern
  `85 C0 74 02 EB FE D9 EE` in `DP.exe`'s `.text` section — and refuses if
  it finds it more than once (would be ambiguous).
* The launcher refuses to patch while `DP.exe` is running.
* SHA-256 of your `DP.exe` is checked against the known-good Steam build
  (`4118eae9...d81fa6`). If your hash differs, the launcher warns you.
* A sidecar JSON (`DP.exe.nanguard.json`) is written next to `DP.exe` recording
  the original bytes, file offset, and pre/post SHA-256. Revert is one click.
* Steam's "Verify integrity of game files" will detect the modified binary
  and silently re-download a clean copy. So you always have an escape hatch
  even if the launcher is uninstalled.

**The patch is marked Experimental** because it has only been validated on
**one** user's hang scenario so far. It is opt-in and easy to undo.

## When should I use it?

**Use it if:**
* You get random "Not Responding" freezes during loading transitions, especially
  in Chapter 3 (hospital scene, after the Shadows fight).
* You've already tried disabling Steam Overlay, capping FPS, etc.
* You're on a stock Steam install of DP DC (the patch only works on the known
  Steam build).

**Don't bother if:**
* You don't experience hangs (the patch is a no-op for healthy gameplay).
* Your hangs happen at a different stage and a different pattern (e.g., a
  hard crash with an error popup, or a hang in main menu). Make a Task
  Manager dump and check `docs/RE_JOURNEY.md` for our known hang signatures.
* You're on GOG, a pirated copy, or a non-standard build. The pattern won't
  match and the launcher will refuse to patch.

## How do I apply it?

1. Open DP1 Launcher → **Settings → Stability** tab.
2. Scroll to **"⚠ Experimental: NaN Hang Guard"**.
3. Click **Scan DP.exe**. If your binary matches, the badge will say
   *"⚙ Ready (not applied)"*.
4. Click **Apply Hang Guard**. Confirm the dialog.
5. Launch the game and play.

If you still hang at the same spot, the bug is a different one — see the GPU
Compatibility card above the NaN Guard for a DXVK preset recommendation,
or report your case on the GitHub issues page (with a Task Manager dump).

## How do I undo it?

**Easy way:** Settings → Stability → NaN Hang Guard → **Revert**.

**Manual way (if launcher is uninstalled):**

* Open `<game folder>\DP.exe.nanguard.json` — it records the file offset
  (typically `0x92A6`) and the original bytes (`EB FE`).
* Open `DP.exe` in any hex editor, navigate to that offset, change
  `90 90` back to `EB FE`, save.
* Delete `DP.exe.nanguard.json`.

**Lazy way:** Steam → DPC → Properties → Installed Files →
**Verify integrity of game files**. Steam re-downloads a clean `DP.exe`.

## What it does NOT fix

This patch is one piece of the puzzle. Other hang/crash classes need
different fixes:

* **Steam overlay + XAudio2 deadlock** (dump #2 signature) — disable Steam
  Overlay for DP DC.
* **Legacy AMD/Intel D3D9 driver deadlock** (dump #3 signature, AMDXN32.DLL
  spinning) — switch to the **DPfix + DXVK** preset on the Presets tab,
  routing D3D9 through Vulkan and bypassing the legacy driver entirely.
* **Audio pool overflow** — empirically refuted in v1.3.0; not a thing
  in practice (max observed = 3/64 slots even under stress).
* **Cutscene codec issues** (WMV freezes/black screens) — covered by the
  Media Compatibility check on the Stability tab.

For the full chronology of what we tried, what worked, and what didn't:
[`docs/RE_JOURNEY.md`](./RE_JOURNEY.md).

## Where to file issues

GitHub: https://github.com/dplauncher/DP1-Launcher/issues

When reporting a hang please include:
1. A Task Manager dump of frozen `DP.exe` (right-click in Task Manager →
   Create dump file → upload to filebin/mega/wherever).
2. The exact in-game step that triggered the hang.
3. Whether the NaN Hang Guard was applied at the time (Settings → Stability
   → check the badge).
4. Your GPU + driver version (Settings → Stability → GPU Compatibility
   card shows this).
