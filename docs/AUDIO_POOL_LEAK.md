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

## Real fix candidate — v1.3.0 plan (not implemented yet)

The correct fix checks `pool->count >= 64` **before** the lock+Pop
sequence:

```asm
At FUN_007039f0 entry:
  CMP [ECX+4], 0x40       ; 4 bytes: count vs 64
  JGE return_full          ; 2 bytes
  (original prologue ...)
return_full:
  OR  EAX, 0xFFFFFFFF      ; 3 bytes: return -1
  RET                       ; 1 byte
```

Plus a 2-byte guard in the caller `FUN_007019b0`:
```asm
After CALL FUN_007039f0:
  TEST EAX, EAX
  JS  skip_enqueue          ; if EAX < 0, skip
  (continue with normal flow)
```

This requires ~16 bytes of new code, which exceeds the 11-byte CC
padding cave after FUN_007039f0. Either we find another cave in
`.text`, or we move some original instructions out to make room.
Future RE session.

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
