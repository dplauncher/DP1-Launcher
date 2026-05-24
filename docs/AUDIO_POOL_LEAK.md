# Audio Pool Exhaustion — Long Session Crashes in Deadly Premonition

> A reverse-engineering write-up of an architectural memory-pool bug in
> `DP.exe` that causes the game to crash after long play sessions,
> especially around scenes with many sound effects (Chapter 9, busy
> Greenvale areas, repeated cutscene attempts).

## TL;DR

- `DP.exe` allocates audio load-requests from a fixed-size pool of
  **64 slots** (`TPoolList<CAudio_Data::LOADREQUEST_ITEM, 64, 0>`).
- The pool's `Alloc()` function has **no overflow check**: when the
  pool is full it returns a garbage index, the caller dereferences a
  garbage pointer, and the game crashes (or silently corrupts heap and
  crashes seconds later).
- Each enqueued audio request must be `Free()`'d by the audio worker
  thread after the sound finishes playing. If the audio thread or the
  cutscene that spawned the request crashes mid-play, the slot is
  **never returned** — a slow leak.
- After a few crashed cutscenes (Chapter 9 is notorious for this), the
  pool fills up, the next sound effect triggers the null-deref path,
  and the game CTDs.
- Combined with the FPS-timing bug (see `FPS_TIMING_BUG.md`), this
  forms the second pillar of the "long-session DPC crash" mythology.

## Reverse engineering

### Pool structure

From decompiling the constructor (`FUN_00703810`):

```c
struct TPoolList<CAudio_Data::LOADREQUEST_ITEM, 64, 0> {
  +0x0000:  vftable
  +0x0004:  int   count;                  // currently-allocated slots
  +0x0008:  bool  in_use[64];             // 64 in-use flags
  +0x0048:  TPopList<uint, 64> free_idx;  // stack of free indices
  +0x0154:  LOADREQUEST_ITEM items[64];   // 64 × 96 bytes
  +0x1954:  CRITICAL_SECTION mutex_a;
  +0x1958:  CRITICAL_SECTION mutex_b;
};
```

### Alloc (`FUN_007039f0`) — the broken one

```c
int Alloc(TPoolList *pool) {
  EnterCriticalSection(&pool->mutex);          // FUN_00401d10
  int *idx_ptr = TPopList::Pop(&pool->free_idx);
  int idx = *idx_ptr;                           // <-- NO CHECK if Pop succeeded!
  pool->count++;
  pool->in_use[idx] = 1;                        // <-- in_use[garbage]
  LeaveCriticalSection(&pool->mutex);
  return idx;                                   // <-- caller gets garbage idx
}
```

When the pool is full, `TPopList::Pop` returns a stale or null pointer.
Dereferencing it returns either uninitialized memory or 0, which the
function then uses as an index into the `in_use[]` array. The result
is either a crash on the dereference or a silent out-of-bounds write
that corrupts heap memory belonging to a different object.

### Free (`FUN_00703a50`) — the partner

```c
void Free(TPoolList *pool, int idx) {
  EnterCriticalSection(&pool->mutex);
  TPopList::Push(&pool->free_idx, idx);         // FUN_00704130
  pool->count--;
  pool->in_use[idx] = 0;
  LeaveCriticalSection(&pool->mutex);
}
```

This is fine in isolation. The bug isn't here — it's that Free is
called by the **audio worker thread** asynchronously, and if that
thread dies during a crash recovery, slots stay allocated forever.

### Single allocation callsite

The pool only has **one allocator function** in the entire game —
`FUN_007019b0`, the audio enqueue function:

```c
void* AudioEnqueue(this, queue, sound_data) {
  Lock(this+0x184);
  int idx = Alloc(this->audio_pool);            // FUN_007039f0
  void *item = pool_items[idx];                 // FUN_00703ab0
  InitItem(item, sound_data);                   // FUN_00702d80
  item->offset_58 = 0;
  item->offset_5C = 0;
  Unlock(this+0x184);

  PushToQueue(queue, idx);                      // hand off to audio thread
  return queue;
}
```

Notice: **no check on `idx` validity** before using it as a pool offset.
No retry. No graceful fallback. No skip-this-sound path.

## Repro pattern

The bug is **deterministic per session state**: once enough slots have
been leaked, the next allocation will crash. The amount of leakage
depends on how many cutscenes have failed during the session.

Community-known triggers (from PCGamingWiki / Steam threads):

- Chapter 9 diner cutscene (multiple sound layers, history of crashing)
- Heaven & Hell Gas Station after-cutscene (Chapter 8)
- "Seven bones" inventory cutscenes (Chapter 8)
- Long sessions in busy Greenvale areas (cars, NPC dialogue, ambient)

## Mitigations

Without source code, a clean fix requires hex-patching `DP.exe` to add
an overflow check in both `Alloc` and the caller. This is a 2-site
patch with code-cave logistics — risky without extensive testing.

**Pragmatic mitigations the launcher ships:**

1. **Session-time reminder** — the launcher tracks `DP.exe` uptime and
   surfaces a one-time toast at 3 hours suggesting a graceful restart.
   This drains the pool by re-initializing the game process before the
   accumulated leakage matters.
2. **Autosave-backup** — already-shipped feature that snapshots
   `dp.sav` every 2 minutes, so if a long-session crash corrupts state,
   you can roll back without losing meaningful progress.
3. **FPS Cap 60** (see `FPS_TIMING_BUG.md`) — reduces the number of
   cutscene crashes that produce orphaned audio slots, slowing the
   leak rate significantly.

## Why we ship session-time reminders instead of a hex patch

A binary patch that adds overflow handling would need to:

1. Patch `FUN_007039f0` (Alloc): insert a `cmp count, 64` + early
   `return -1` path. Requires a code cave because the function is
   tightly packed (~70 bytes, no padding).
2. Patch `FUN_007019b0` (AudioEnqueue): insert a `cmp idx, 0; jl skip`
   so the function bails out instead of dereferencing a `-1` index.
3. Test that legitimate audio paths still work — every sound effect,
   every cutscene voice line, every menu blip.

This is a multi-week effort for one person. The 3-hour-restart reminder
delivers ~90% of the user-visible benefit with zero risk to the binary.

## Patch attempt (v1.2.0/v1.2.1) — and why it was reverted

In v1.2.0 we shipped an experimental 10-byte 2-site hex patch that
attempted to add a null-check around the deref:

```
File 0x302E12 (FUN_007039f0 + 0x22):
  8B 00          → EB 31          ; redirect to safety cave
File 0x302E45 (CC padding cave):
  CC CC CC ...   → 85 C0 74 02 8B 00 EB C7
                 ; TEST EAX, EAX / JZ +2 / MOV EAX, [EAX] / JMP back
```

The intent: when Pop returns null, skip the deref, leave EAX=0,
return slot 0 to the caller (graceful reuse instead of CTD).

**Field testing revealed a flaw:** on save-load paths, `TPopList::Pop`
does not return a clean `NULL` when the stack is empty — it returns a
**garbage non-null pointer** (likely a stale stack address from previous
frame). Our `TEST EAX, EAX` did not catch this, so the patched code
still dereferenced a wild pointer → infinite loading screen on
completed-game saves (Chapter 6+ community saves, end-game replays).

We reverted the patch in v1.2.2 and disabled the toggle.

## v1.3.0 attempt — also failed (architecturally unfixable)

We tried the pre-Pop count check as planned. Two-site patch:

1. **Caller patch** at file `0x300DD0`: redirect `CALL FUN_007039f0`
   to a 15-byte cave we found at VA `0x00701A41` (only ~+113 bytes
   from the call site).
2. **Cave wrapper** at file `0x300E41`:
   ```asm
   CMP [ECX+4], 0x40       ; check pool->count
   JGE return_full
   JMP rel32 → FUN_007039f0 ; tail-call to original
   return_full:
   OR  EAX, 0xFFFFFFFF      ; return -1
   RET
   ```

**Result: still infinite loading.** Trace:

```c
// caller (FUN_007019b0) — UNCHANGED, has no error path
int idx = wrapper();                          // returns -1 when full
void *item = pool->items[idx];                 // → pool[-1] → invalid pointer
FUN_00702d80(item, sound_data);                // writes to invalid pointer
                                                // → memory corruption
                                                // → infinite loading
```

The caller `FUN_007019b0` **does not check the return value** of
Alloc. It assumes Alloc always succeeds. Any sentinel value
(`-1`, `0`, `null`, garbage) breaks the next instruction
`pool->items[idx]` because it's a raw memory access on the returned
index.

## Why this is architecturally unfixable from binary alone

A working fix needs *both*:

1. Alloc reports failure (we can do this in a cave).
2. Caller skips the rest of the function on failure (we cannot —
   requires ~10 bytes of injection in the tightly-packed caller and
   another ~10 bytes for the early-return cleanup, far exceeding any
   available cave near `FUN_007019b0`).

Other approaches we considered and rejected:

| Approach | Bytes needed | Blocker |
|---|---|---|
| Force-Free slot 0, retry Alloc | 26+ | Race condition with audio worker thread mid-play |
| Spin-wait until a slot frees | 8 | Caller holds outer mutex; audio worker may need it → deadlock |
| Rewrite caller in place | 70+ | No caves > 15 bytes anywhere in .text |
| 2-cave chained patch | 11 + 15 | Audio worker thread arch unknown; still race-prone |

A proper fix requires either:
- The game's source code, or
- A deep RE of the audio worker thread (FUN that consumes the queue
  and calls Free) to understand the sync primitives and design a
  patch that won't deadlock or race.

The first is impossible. The second is multi-week work.

## What the launcher ships instead

We accept the limitation and provide *soft* mitigations:

1. **Session-time reminder** (v1.2.2): toast at 3 hours of `DP.exe`
   uptime, suggests a graceful game restart. Restarting drains the
   pool naturally without touching the binary.
2. **FPS Cap 60** (v1.1.0 fix): eliminates the timing-related cutscene
   crashes that *cause* the audio-pool leak in the first place. With
   fewer cutscene crashes, the pool stays much further from 64.
3. **Codec Fix** (LAV merit): reduces cutscene-specific crashes from
   K-Lite/LAV decoder bugs, again slowing the leak rate.
4. **Autosave Backup**: protects against state loss if an
   audio-pool-exhaustion crash does eventually happen.

Combined, these reduce the practical incidence of the bug from
"chronic" to "very rare in normal play sessions".

## Postscript — Xbox 360 vs PC root cause (May 25, 2026)

After all the binary-patch attempts failed, we obtained the Xbox 360 release
of DP and compared. Findings:

1. **Audio data is identical.** Both versions ship the same XACT
   sound banks (`sound/*.xsb` + `*.xwb`). The PC port did not convert
   the audio, just kept Xbox-format files.

2. **Audio runtime is completely different.** `DP.exe`'s PE imports
   table contains **no `xactengine*.dll`**. Access Games wrote their
   own XACT loader from scratch for the PC port, instead of using
   Microsoft's `xactengine2_0.dll`/`xactengine3_7.dll` that ship with
   Windows (and that `redist/DXSETUP.exe` would have installed).

3. **The `TPoolList<LOADREQUEST_ITEM, 64, 0>` is the custom loader's
   pool.** The size of 64 matches XACT's documented internal limit
   for simultaneous load requests. But the custom loader is a
   minimal reimplementation: same numeric limit, **no overflow
   handling**. Production Microsoft XACT has it; this clone doesn't.

This explains:

- Why the bug class exists on PC and not Xbox: different runtime,
  not different content.
- Why binary patches to `FUN_007039f0` / `FUN_007019b0` keep breaking
  things: those functions are part of a hand-rolled audio loader with
  unknown invariants; we can't safely inject error paths without
  understanding the audio worker thread that's supposed to call `Free`.
- Why "smoke a cigarette" works as a community workaround for
  Chapter 9 crashes: it skips game time past the script transition
  that loaded the offending sound — a state-machine bug downstream
  of an unreliable loader.

A theoretically clean fix would write a proxy DLL that intercepts the
custom loader's entry points and dispatches into Microsoft's
`xactengine2_10.dll` instead. Estimated effort: multi-week, ABI unknown.
Not pursued.

Full context in [`RE_JOURNEY.md`](RE_JOURNEY.md) postscript section.

## Credits & references

- Steam community forum reports (Chapter 8/9 crash pattern, "smoking
  helps" workaround) — empirical foundation
- PeterTh/dpfix — reference codebase that taught us how the engine
  was instrumented in 2013
- Ghidra Software Reverse Engineering Suite — for the actual binary
  analysis

---

*This document is part of the DP1 Launcher project. See also
`FPS_TIMING_BUG.md` for the related delta-time bug analysis.*
