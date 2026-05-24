# DP1 Audio Guard (Frida prototype)

Runtime instrumentation tool for diagnosing the audio-pool overflow class
of bugs in *Deadly Premonition: The Director's Cut* (`DP.exe`).

Hooks four functions inside the running game and logs pool pressure,
allocator/free balance, and anomaly events that would precede a crash.
Useful for:
- Confirming whether a user's gameplay actually stresses the audio pool
- Capturing the exact moment of overflow if it occurs
- Validating that future binary patches behave correctly

This is an **observation tool**, not a fix. It does NOT modify game
behaviour. Pass-through only.

## Status

Phase A — fully validated on RTX 5070 + DXVK 2.7.1 + SSD setup as of
2026-05-25. All four hooks fire reliably with correct signatures:

| Function | VA | Signature | Validation |
|---|---|---|---|
| Enqueue | `0x007019B0` (`FUN_007019b0`) | `__thiscall(this, queue, sound_data)` | hook fires, ECX = this object |
| Free | `0x00703A50` (`FUN_00703a50`) | `__thiscall(pool, idx)` | hook fires, pool addr matches |
| Alloc | `0x007039F0` (`FUN_007039f0`) | `__thiscall(pool) → idx in EAX` | EAX cross-checked with in_use[] diff |
| Push | `0x00704130` (`FUN_00704130`) | `__thiscall(this, const uint32_t* p_idx)` **by-pointer** | idx correlates with Free's lastFreeIdx |

Real `Pop` address is still TBD (called from inside Alloc). Not critical
because Alloc-level validation through in_use[] diff catches the same
class of bugs.

## Pool layout (validated)

```c
struct ParentObject {
    ...
    TPoolList<LOADREQUEST_ITEM, 64, 0> pool;   // at this + 0x1070 (INLINE EMBEDDED)
    ...
};

struct TPoolList {
    void*           vftable;       // +0x0000
    uint32_t        count;         // +0x0004  ← what we monitor
    bool            in_use[64];    // +0x0008
    TPopList<uint>  free_idx;      // +0x0048
    LOADREQUEST_ITEM items[64];    // +0x0154  (96 bytes each)
    CRITICAL_SECTION mutex_a;      // +0x1954
    CRITICAL_SECTION mutex_b;      // +0x1958
};
```

## Usage

```bash
pip install frida frida-tools
```

Start the game (via launcher → Steam → DP.exe). Then:

```powershell
# Attach to running DP.exe
python audio_guard.py

# OR: spawn DP.exe under Frida control
python audio_guard.py --spawn
```

Press `Ctrl+C` to detach cleanly. The game keeps running.

## What you'll see

**Quiet mode (count < 8, balanced):**
```
[ALC #0001] eax=63 in_use_diff=63 ✓ count 0→1
[ENQ #0001] count 0→1 ret=0x73861e
[PSH #0001] idx=63 via *[esp+4] vs lastFree=63 ✓
[FRE #0001] idx=63 count 1→0
... (first 10 hits logged in full, then silent)
── HB: enq=N fre=N max=M/64 ratio=1.00 (heartbeat every 30s)
```

**Anomaly events (always logged):**
- `▸ NEW_CALLER` — first time a return address appears
- `▸ NEW_THREAD` — first time a thread id appears
- `▸ THRESHOLD_CROSS` — count first reached 8 / 16 / 32 / 48 / 60
- `⚠ RATIO_DRIFT` — rolling enq/free ratio > 1.10
- `⚠ FREE_STALL` — no Free for 10s+ AND active slots exist
- `⚠ SATURATION` — Alloc called when count was already 64
- `⚠ ALLOC_BROKEN` — both EAX and in_use[] diff inconsistent (real overflow)
- `⚠ GHOST_DELTA` — pool count moved without our hooks accounting for it
- `⚠ INVALID_IDX_PUSH` — Push received an idx outside 0..63 (no candidate fits)

## What we've learned

After several gameplay sessions on RTX 5070 / SSD:

- Normal exploration: `max_count = 1`
- Light combat / NPC dialogue / car interaction: `max_count = 2`
- All 4 hooks fire on a single thread (`tid=26224`) — **PC port has no audio worker thread**
- Single caller of Enqueue (`ret=0x73861e`) — central audio dispatcher
- Pool slot reuse is LIFO via TPopList — slot 63 stays "hot", others rarely used

**Conclusion**: pool overflow is architecturally rare on modern hardware.
The PC port's `TPoolList<...,64,0>` has 64-slot capacity but normal play
uses 1-2 slots. Crashes likely require:
- Slow IO (HDD) holding slots longer
- Specific crash-prone cutscenes (Chapter 9 art-gallery exit) producing orphan slots
- Long sessions (4+ hours) for accumulated rare leaks

See [`docs/AUDIO_POOL_LEAK.md`](../docs/AUDIO_POOL_LEAK.md) and
[`docs/RE_JOURNEY.md`](../docs/RE_JOURNEY.md) for full RE history.

## Phase B (not implemented)

If overflow IS reproduced (Chapter 9 community save, long session), the
next phase activates active skip:

```js
// Hook on FUN_007019b0 entry
if (pool.count >= 62) {
    // PS3-equivalent "Maximum instruction queue reached" path
    return queue;  // skip enqueue, return queue unchanged
}
// otherwise normal call into original
```

This restores the console-level overflow defence that the PC port omitted.
See PS3 evidence in `docs/AUDIO_POOL_LEAK.md`.

## Troubleshooting

**`Attach failed: process refused to load frida-agent`**
- Run PowerShell as Administrator
- Temporarily disable DXVK via launcher toggle (renames d3d9.dll)
- Add `audio_guard.py` + `python.exe` to Windows Defender exclusions
- Try `--spawn` flag to start DP.exe under Frida control

**`DP.exe not running`**
- Start the game first via launcher → Steam, then re-run the script
- OR use `--spawn` to have Frida launch DP.exe itself
