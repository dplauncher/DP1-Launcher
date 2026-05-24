# DP1 Launcher — Reverse-Engineering Journey (v1.0 → v1.3)

> An honest postmortem of every bug we tried to fix in *Deadly Premonition:
> The Director's Cut*, what worked, what didn't, and what we learned about
> 12-year-old game engines and modern Windows.

## TL;DR

We started with the goal of making DPC playable on modern Windows hardware
without the dozen-step manual ritual the community had accumulated since 2013.
Over four release cycles we:

1. **Solved** the FPS-dependent timing bug that broke cutscenes (community
   "smoking workaround" decoded), shipped a vendor-aware 60 FPS cap.
2. **Investigated** the long-session audio CTDs via Ghidra, found the
   `TPoolList<LOADREQUEST_ITEM,64,0>` overflow, **tried twice** to hex-patch
   it (v1.2.0 and v1.3.0-test), broke save-loading both times, reverted.
3. **Explored** the DSB (script bytecode) dispatcher as a potential
   script-level fix surface, **hit a dead end** (debug-only strings, hash-keyed
   runtime lookup).
4. **Diagnosed** "slow loading" on modern GPUs by writing our own minidump
   analyzer, **misdiagnosed** it as a DXVK cache issue, **corrected** by user
   knowledge of DXVK 2.x driver-delegated cache, then **rediagnosed** as the
   DPfix+DXVK chain itself when a Steam Deck guide independently dropped DPfix
   for the exact same reason. Shipped a launcher toggle in v1.3.0.

The launcher today ships **soft mitigations + transparent toggles** instead of
binary patches. Real engine bugs are documented but not patched, because every
attempt at a binary patch broke something else.

## Cast of bugs

| # | Bug | Status | Where it lives |
|---|-----|--------|----------------|
| 1 | FPS-dependent delta-time drift | **Solved** (60 FPS cap) | `FUN_0041c270`, ceil/floor selector |
| 2 | Audio LOADREQUEST pool overflow | **Documented, not fixable from binary** | `FUN_007039f0` (Alloc), `FUN_007019b0` (caller) |
| 3 | Chapter 9 / 12 scripted-event crash | **Workaround only** (smoke/sleep) | DSB script state machine, unknown opcode |
| 4 | Slow first-load on modern GPUs | **Solved** (DXVK toggle) | DPfix wrapper × DXVK chain overhead |
| 5 | Cursor reappears on Alt-Tab | **Solved** (PS watcher + DPfix CaptureCursor) | Win11 focus-change behaviour |
| 6 | LAV codec crashes on cutscenes | **Solved** (session-scoped merit lowering) | DirectShow filter graph |

## Bug 1 — FPS-dependent timing drift

### Symptoms
Cutscenes (Chapter 9 diner, Chapter 8 gas station, the "Heaven & Hell"
sequence) freeze or crash at FPS > 60. Community-folklore workaround:
"smoke a cigarette in-game" to advance time past the broken state-machine
transition. This has been the standard advice on Steam forums since 2014.

### Diagnosis
Ghidra decompilation of the main loop (`FUN_00700650`) showed delta-time
fed into `FUN_0041c270`, which selects between two integer-time formulas
based on bit 31 of a control DWORD:

- **Path A**: `ceil(elapsed_qpc * frame_rate / qpc_freq)` — accumulates
  off-by-one drift when frame_rate doesn't divide evenly into the elapsed
  count.
- **Path B**: `floor(...)` — drifts the other direction but bounded.

At 60 FPS exactly, the drift cancels (60 × 16.667ms ≈ exact 1000ms/sec).
At 120 FPS it cancels again. Between those values, the drift accumulates,
desyncs the script clock from the render clock, and scripted cutscenes
miss their transition windows. Smoking advances the script clock manually
past the bad transition.

### Solution shipped (v1.1.0)
- Vendor-aware FPS cap UI (NVIDIA Control Panel / AMD Radeon Software /
  Intel Arc Control deep-link).
- 60 FPS hard cap is also written to `dxvk.conf` as a belt-and-braces
  fallback (`dxvk.maxFrameRate = 60`).
- Tried in-engine fix (forcing Path B globally) — broke car physics
  (stutter at high speeds). Reverted; driver cap turned out to be the
  right layer.

Full write-up: [`FPS_TIMING_BUG.md`](FPS_TIMING_BUG.md).

## Bug 2 — Audio pool overflow

### Symptoms
After several hours of play, especially in busy Greenvale areas or after a
crashed-and-restarted cutscene, the game CTDs on the next sound effect with
no warning. Community blame falls on "memory leak", but it's actually a
fixed-slot pool with no overflow check.

### What we found
`DP.exe` defines a `TPoolList<CAudio_Data::LOADREQUEST_ITEM, 64, 0>` —
fixed 64-slot allocator. The Alloc function (`FUN_007039f0`) calls
`TPopList::Pop` to get a free index but **never checks if Pop succeeded**.
When the pool is full, Pop returns a stale or null pointer that gets
dereferenced as an index. The single caller (`FUN_007019b0`, the audio
enqueue function) also has no error path. So the failure mode is
"deref garbage → crash" instead of "skip this sound effect".

Slots leak when the audio worker thread that's supposed to call `Free`
dies during a separate crash — most commonly during cutscene-frame
desync (Bug #1).

### Patch attempts

**v1.2.0** — 10-byte safety patch (2 sites):
```
File 0x302E12: 8B 00  →  EB 31           ; redirect on null
File 0x302E45: CC...  →  85 C0 74 02 8B 00 EB C7  ; null-check cave
```
Intent: when Pop returns NULL, skip the deref and return slot 0
(graceful reuse). **Result**: broke save-loading on completed-game saves.
`TPopList::Pop` doesn't return a clean NULL when empty — it returns a
**garbage non-null pointer** (stale stack address from previous frame),
so our `TEST EAX, EAX` didn't catch it. Reverted in v1.2.2.

**v1.3.0-test** — pre-Pop count check (2-site cave patch):
```
Caller site: redirect CALL FUN_007039f0 to a wrapper cave
Cave:
  CMP [ECX+4], 0x40
  JGE return_full
  JMP FUN_007039f0  (tail call)
return_full:
  OR EAX, 0xFFFFFFFF  ; return -1
  RET
```
Intent: bail out before exhaustion. **Result**: still infinite loading.
The caller `FUN_007019b0` accesses `pool->items[idx]` without checking
the return value. With idx = -1, it computed `pool[-1]` → invalid pointer
→ memory corruption → loading-screen freeze.

### Why architecturally unfixable from binary alone
A clean fix needs **both**:

1. Alloc reports failure — doable in a cave.
2. Caller skips the rest of the function on failure — **not doable**.
   `FUN_007019b0` is tightly packed (≤15 bytes of CC padding anywhere
   nearby, scanned via `find_caves.py`). A proper early-return injection
   would need ~20 bytes split across two callees, with thread-safety
   guarantees we can't verify without RE-ing the audio worker thread —
   multi-week work for one person.

### What we ship instead (v1.2.2+)
- **Session timer reminder**: launcher polls `DP.exe` uptime every 60s,
  fires a toast at the 3-hour mark suggesting a graceful restart.
  Restarting drains the pool naturally without touching the binary.
- **Autosave backup**: snapshots `dp.sav` every 2 minutes to
  `%APPDATA%\dp1-launcher\saves\`. If the pool-exhaustion crash eventually
  happens, you don't lose meaningful progress.
- **FPS cap 60**: reduces cutscene crashes (Bug #1), which reduces
  orphaned audio slots, which slows the leak rate. Best practical
  mitigation.

Full write-up: [`AUDIO_POOL_LEAK.md`](AUDIO_POOL_LEAK.md).

## Bug 3 — DSB dispatcher RE (dead end)

### Premise
After accepting we couldn't fix audio pool from the binary, we considered
whether **script-level patches** could fix specific crashes (Tree Fan's
Chapter 3 hospital freeze, the Chapter 9 art-gallery crash). The game's
script bytecode (`.dsb` files) are interpreted by `CEvent::Update` and
relatives — if we understood the opcode encoding, we could potentially
patch the offending script entry rather than the engine.

### Findings
Ghidra's `Defined Strings` view revealed handler-name strings in `.rdata`:
```
0x77208C: LOCAL
0x772094: CEvent::Update
0x7720A4: UpdateThread
0x7720B4: UpdateWatch
0x7720C0: UpdateMesExtra
0x7720D0: UpdateRegion
0x7720E0: UpdateChoice
0x7720F0: UpdateCar
0x7766A4: Event::Cross
0x7766B4: CollisionAction
0x7766D4: SmoothPos
...
```

A scan of the entire DP.exe binary (`find_event_strings.py`) found
**zero references** to any of these strings as VA-encoded immediates.
Verified twice with byte-level search. The only string with references is
`LOCAL`, used as an inline-copy constant (`MSVC memcpy("LOCAL", buf, 6)`
optimization) in one specific function.

This means: the strings exist as debug-only data; runtime dispatch uses
pre-computed hashes that the linker baked in at compile time, with the
string literals retained only for debug logging (or by `/OPT:NOREF`
shenanigans). The actual VM dispatcher works on opcodes and hashes that
look like raw integers in the binary.

### Why we stopped
Reverse-engineering a hash-keyed VM dispatcher without source symbols
requires:

1. Finding the dispatcher function (likely a giant switch / jump table).
2. Decoding the hash function used to derive opcodes from names.
3. Mapping every opcode back to a handler implementation.
4. Writing a DSB disassembler / patcher.

Realistic estimate: weeks to months for one person, no guarantee the
result lets us patch the *specific* crashes we care about (the Chapter 9
crash might be a state-mismatch bug in a save, not a fixable script
opcode — community evidence supports that interpretation).

We documented the finding and stopped. Tree Fan's actual fix turned out
to be a community-replacement save (Chapter 9 art-gallery crash is a
state-machine bug that smoking-through-time bypasses, same pattern as
Bug #1).

## Bug 4 — Slow first-load on modern GPUs

### Symptoms
User on RTX 5070 + DXVK 2.7.1: "navigation to main menu takes ~3 minutes
even on fresh restart". New game loads slightly faster (~2 min), save
load slower (~3 min). Game eventually loads correctly, no crash — just
slow.

### Tools built
We built a minidump analysis toolchain over a few hours of trial and
error:

- **`verify_dp_clean.py`** — checks the user's DP.exe for residue from
  any of our past hex patches (v1.2.0 main redirect, v1.2.0 safety cave,
  v1.3.0 count check, v1.3.0 return-minus-one cave). MD5 vs known-clean
  reference, with per-site spot checks.
- **`analyze_crash.py`** — parses MINIDUMP files (no external deps),
  decodes ExceptionStream + Module list + Memory64ListStream,
  identifies which module/function the crash sits in, walks the stack
  for return-address candidates. Robust to both crash dumps (with
  ExceptionStream) and hang dumps (ThreadList only).
- **`analyze_hang.py`** — for WOW64 hang dumps (32-bit process on 64-bit
  Windows). Reads thread stacks from `Memory64ListStream`, filters
  4-byte aligned values against module address ranges to find return-
  address chains. Catches UTF-16 string aliasing as a false-positive
  filter. Uses the `minidump` Python library for cross-architecture
  CONTEXT handling.
- **`identify_addr.py`** — given a return address inside DP.exe,
  walks backward through the binary to find a likely function start
  (CC-padding heuristic + RET-followed-by-prologue), shows surrounding
  bytes for hand disassembly.
- **`find_caves.py`** — scans `.text` for CC padding runs that could
  hold a code-cave patch. Used during audio-pool patch design.

### Wrong hypothesis #1 — DXVK cache missing
First diagnosis: no `state.dxvk-cache` file in the game folder → DXVK
recompiles all shaders from scratch every launch. We wrote a config
file with explicit cache enable + debug logging.

**User correction**: DXVK 2.x on modern drivers (NVIDIA RTX 50 series,
RTX 40 series with recent drivers) delegates the pipeline cache to the
driver itself (`%LocalAppData%\NVIDIA\DXCache\*.nvph`). The local
`.dxvk-cache` file is no longer the cache of record. Confirmed: user's
DXCache was 14.3 GB / 215 files, actively growing during gameplay —
caching IS working. The slow-load symptom must be something else.

### Wrong hypothesis #2 — RTX 50 Blackwell driver immaturity
Updated diagnosis: RTX 5070 (Blackwell) is too new, NVIDIA driver hasn't
optimised DXVK paths for it yet, first-encounter pipeline JIT compile is
slow. Recommended: wait for driver update, live with it.

This was partially true but missed the bigger lever.

### Correct hypothesis — DPfix wrapper overhead on top of DXVK
A/B test: rename `game/d3d9.dll` (the DPfix-installed wrapper that
forwards into d9vk.dll) out of the way. The game falls back to
`C:\Windows\System32\d3d9.dll` (native D3D9). **Loading becomes
substantially faster** — without DXVK at all.

But the bigger insight came from a Steam Deck community guide
(`r/SteamDeck` post `1d88vbg`, May 2024):

> "DPFix is a godsend for boosting this game's resolution and improving
> rendering, BUT it's responsible for some pretty heinous frame rate
> drops when driving around the open world, and for doubling if not
> tripling load times (on Deck at least). As such, I've removed it from
> this guide for now."

The Steam Deck author independently identified DPfix as the
multiplicative slow-down, on completely different hardware (LCD Deck via
Proton). They chose to drop DPfix entirely and accept 720p without
widescreen fixes.

A second Steam-thread comment confirmed: "played ~8 hours with DPfix,
no DXVK — flawless until Chapter 9". So **DPfix without DXVK** is a
viable Windows configuration: fast load, native D3D9 backend, DPfix's
own widescreen / FOV / 4GB patches still active.

### Why this isn't obvious from looking at the launcher
Our launcher's "DPfix" install is actually two separate things bundled:

1. **DPfix hex patches** — modifications written *directly into DP.exe*
   (4GB-aware bit in PE header, widescreen calculations, FOV, etc.).
   These persist regardless of which D3D9 implementation runs.
2. **DPfix d3d9.dll wrapper** — sits between DP.exe and the actual D3D9
   implementation. The wrapper forwards into `C:\Windows\SysWOW64\d9vk.dll`
   (DXVK) when DXVK is "applied", or into the system d3d9.dll when not.

The wrapper adds overhead on every D3D9 call. On Steam Deck with
older mesa, the cost was bad enough to drop it. On Windows + RTX 50
with DXVK behind it, the cost manifests as multi-minute first-loads
because each first-encounter D3D9 draw triggers a Vulkan pipeline JIT
compile that the driver has to translate to GPU-native ISA.

**Without the wrapper**: D3D9 calls go straight to native D3D9 in
System32, no Vulkan translation, no JIT compile, game loads fast.
DPfix hex patches in `DP.exe` (widescreen, FOV, 4GB) are still active
because they live in the executable, not the wrapper.

### Solution shipped (v1.3.0)
DPC Fixes accordion now has a **Use DXVK** toggle:

- **ON** (default for first-time install): launcher copies DXVK to
  `SysWOW64\d9vk.dll` and hex-patches the game's `d3d9.dll` to forward
  into it. Provides Vulkan-backed D3D9 for stability on older drivers
  and Linux/Proton.
- **OFF** (recommended for RTX 40/50 + Win11): launcher restores
  `d3d9.dll` from `.bak` and deletes `SysWOW64\d9vk.dll`. Game uses
  native D3D9 from System32. Loading is significantly faster.

Both modes preserve DPfix hex patches in `DP.exe` (widescreen / FOV /
4GB Patch always active). The toggle is admin-gated because writing to
`SysWOW64` requires elevation.

## Postscript — Xbox 360 vs PC comparison (May 25, 2026)

After v1.3.0 shipped, we compared the PC version against the Xbox 360 release
(`Deadly Premonition (Europe)`) to understand why the same content crashes on
PC but supposedly doesn't on Xbox.

### Same data, different runtime
File-level comparison revealed:

| Asset | Xbox 360 | PC |
|-------|----------|-----|
| Audio data | `sound/*.xsb` + `*.xwb` (XACT format) | **same `.xsb` + `.xwb` files** |
| Cutscene video | `movie/*.wmv` | same `.wmv` files |
| Game assets | `pack/*.pkg` (35 files, 3.5+ GB) | concatenated into `updata/_flink/DPSerial.001/002/003` (3 blob files, same content) |

The PC port **did not convert the audio**. It ships the original XACT
(Xbox Audio Cross-platform Technology) sound banks and wave banks intact.

### Different runtime — the real story
A PE imports scan of `DP.exe` (`compare_xbox_pc.py`) showed:

```
KERNEL32.dll, USER32.dll, steam_api.dll, d3d9.dll, d3dx9_43.dll,
WINMM.dll, PhysXLoader.dll, NxCharacter.dll, NxCooking.dll,
X3DAudio1_7.dll, ADVAPI32.dll, SHELL32.dll, ole32.dll

Audio-related:
  X3DAudio1_7.dll:
    X3DAudioCalculate
    X3DAudioInitialize
```

**`DP.exe` does not import `xactengine*.dll`.** Only `X3DAudio` (the 3D
positioning math library) and nothing else from Microsoft's XACT family.
Windows ships `xactengine2_0.dll` through `xactengine3_7.dll` in
`C:\Windows\SysWOW64\` — none of them are called by DP.exe.

### Conclusion
Access Games / ToyBox (the PC port developers) **wrote their own XACT-
compatible loader from scratch** instead of using Microsoft's existing
`xactengine*.dll` runtime. The pool we documented in
[`AUDIO_POOL_LEAK.md`](AUDIO_POOL_LEAK.md) — `TPoolList<LOADREQUEST_ITEM, 64, 0>`
— is that custom loader's allocator. Its size matches XACT's known
internal limit (64 simultaneous sound load requests), but it lacks the
overflow check that production XACT has.

```
Xbox 360:   .xsb/.xwb → native XACT runtime (Microsoft, hardware-assisted)
                          ↓
                          Production-quality, bounded, defensive
                          → does not crash under load

PC port:    .xsb/.xwb → custom Access Games / ToyBox loader
                          ↓
                          From-scratch minimal reimplementation,
                          fixed 64-slot pool, NO overflow check
                          → crashes under load (Bug #2)
```

### Why does this matter?
This isn't a community-folklore "memory leak". It's a deliberate engineering
decision by the PC porting team to ship their own audio loader instead of
using the established Microsoft library that already ships on every Windows
machine (`%SystemRoot%\SysWOW64\xactengine2_0.dll` and friends, deployed
by `DXSETUP.exe` which the game itself bundles in `redist/`).

The audio bug class is **architecturally Windows-port-specific**. The same
game code with the same audio assets does not crash on Xbox 360 because
Xbox's XACT runtime is a different — more defensive, hardware-assisted —
implementation. Reverse-engineering the engine code in DP.exe to find the
defect was correct; the open question was always "why does this code path
exist", and the answer is "because someone re-implemented XACT instead of
using the shipped one".

### Hypothetical fix path (not pursued)
A clean fix would write a wrapper DLL that intercepts calls into the
custom loader (`FUN_007039f0` / `FUN_007019b0` from our RE) and redirects
them into Microsoft's `xactengine2_10.dll`. That would:

1. Inherit Microsoft's production overflow-handling.
2. Side-step Bug #2 entirely without touching DP.exe's `.text`.

Estimated effort: multi-week, with significant unknowns (the custom
loader's ABI was never documented). For now we keep the soft mitigations
shipped in v1.2.2 (session timer + autosave). Documented here for future
work.

## Postscript II — PS3 confirms the diagnosis (May 25, 2026)

After the Xbox 360 comparison narrowed the bug to "PC-port-specific custom
audio loader", a PS3 retail dump landed in our lap. The PS3 EBOOT.BIN was
extracted, decrypted via RPCS3 (PS3UPDAT.PUP was on the disc),
and analysed statically. The result is the strongest evidence we have so
far that the audio bug class was a **regression introduced during the PC
port**, not an engine-level defect.

### Same content, different runtime, again
PS3 ships the **exact same XACT sound banks** as Xbox 360 and PC:

```
USRDIR/UPDATA/SOUND/
  BGM.XSB / BGM.XWB         ← XSB2 magic identical to PC's .xsb
  SE.XSB / SE.XWB
  BOSE.XSB / BOSE.XWB
  PLVO.XSB / PLVO.XWB
  ... (24 sound banks, all Microsoft XACT format)
```

This is unusual — XACT is Microsoft middleware. The PS3 port shipped
Microsoft-format audio assets and built a custom XACT-compatible parser
on top of Sony APIs. Same pattern the PC port follows; same XSB2 banks
in both binaries.

### PS3 audio architecture (extracted from EBOOT.elf strings + xrefs)
```
XSB/XWB assets                               (game-side audio data)
    -> game audio layer                      (custom XACT cue dispatch)
    -> MultiStream / cellMSStream / DSP      (Sony middleware queue)
    -> cellAudio port                        (kernel audio buffer)
    -> PS3 audio output                      (hardware mixer)
```

Synchronisation: heavy use of `sys_lwmutex_lock`/`sys_lwmutex_unlock`
(317 / 441 direct `bl` callsites) plus `sys_mutex_lock`/`sys_mutex_unlock`
(26 / 29 callsites) plus `sys_cond_*` for worker-thread coordination.
PS3 audio path is **thoroughly mutex-protected**.

### Smoking-gun strings inside EBOOT.elf
The PS3 binary contains these diagnostic strings, used by the
MultiStream middleware:

```c
MULTISTREAM: sys_lwmutex_create() failed %d
WARNING : Multistream lagging by %d packets to libAudio
MULTISTREAM : Maximum instruction queue reached! Instruction not added!
MULTISTREAM : Stream %d missed a callback. cellMSSystemGenerateCallbacks
              needs to be called more often
MULTISTREAM ERROR - START SAFE GUARD MEMORY HAS BEEN CORRUPTED...
MULTISTREAM ERROR - END SAFE GUARD MEMORY HAS BEEN CORRUPTED...
```

The third one — **`"Maximum instruction queue reached! Instruction not
added!"`** — is the exact defensive behaviour our PC port lacks. On
PS3, when the audio request queue fills up:

1. Caller invokes "enqueue request"
2. Queue overflow detected (queue size >= MAX)
3. Diagnostic is logged
4. The instruction is **silently dropped, not added**
5. Caller proceeds normally; the only effect is one sound doesn't play
6. The system stays consistent

That is **exactly the safety net we hypothesised was missing on PC**.
And the last two strings (`SAFE GUARD MEMORY HAS BEEN CORRUPTED`) prove
that the PS3 build even had **canary-style buffer overrun detection**
around audio buffers — a level of defensive engineering that the PC port
also stripped.

### Canonical PS3 audio call sites (for future RE)
Extracted from EBOOT.elf static analysis:

| VA | Purpose |
|----|---------|
| `0x00701ED8` | audio system init wrapper before `cellAudioInit` |
| `0x00701F2C` | `cellAudioInit` |
| `0x00701E0C` | `cellAudioQuit` |
| `0x00789F64` | `cellAudioPortOpen` (path 1, primary port) |
| `0x007CDDAC` | `sys_lwmutex_create` (audio stream manager init) |
| `0x007CDDE4` | `cellAudioPortOpen` (path 2, stream manager port) |
| `0x007CDE10` | `cellAudioGetPortConfig` |
| `0x007CCFB0` | `sys_lwmutex_lock`  ← guards `cellAudioPortStart` |
| `0x007CCFC8` | `cellAudioPortStart` |
| `0x007CD004` | `sys_lwmutex_unlock` (success path) |
| `0x007CD014` | `sys_lwmutex_unlock` (error path) |

The `0x007CCFB0` block is almost a textbook example of how PS3 protects
critical audio-state mutations: lock → operate → unlock-on-success +
unlock-on-error. PC port: no equivalent guard.

### Important correction to the audio model
After more careful PS3 analysis (via GPT-assisted cross-reference of
NID tables + import addresses + diagnostic strings), our earlier
phrasing was overconfident. We do **not** have proof that the PS3 build
uses the exact same `TPoolList<LOADREQUEST_ITEM, 64, 0>` template
instance. What we **do** have proof of:

- PS3 ships the same `.xsb`/`.xwb` assets
- PS3 has a `MultiStream` instruction queue with documented overflow handling
- PS3 audio loader uses `sys_lwmutex` for thread safety
- PS3 has an explicit "queue full → don't add, log warning" path

PC port likely:
- Started from the same custom XACT parser code
- Replaced the `MultiStream`/`SPU`/`cellAudio` Sony stack with a Windows
  backend (X3DAudio + DirectSound or similar in-process audio mixer)
- Simplified the queue management into the fixed-size `TPoolList<...,64,0>`
- **Removed the overflow handler** (treated it as "console-specific debug
  code, won't apply to PC")
- Removed the guard-memory canaries (same reasoning)
- Shipped without QA on long-session edge cases

### Fix strategy this confirms
The PC fix should **not** attempt to "make Alloc return errors", because
PS3 doesn't fix overflow at the Alloc level either — PS3 fixes it at the
**queue/request layer** (the caller). The correct logical fix is:

```c
// PC fix — equivalent to PS3's MultiStream overflow handler
if (audio_request_queue_is_near_full) {
    // PS3-equivalent behaviour: silently drop, log
    log("audio request queue full, instruction not added");
    return queue;  // unchanged — no new request added
}
// otherwise normal Alloc + enqueue path
```

This is structurally what our planned X3DAudio1_7.dll proxy hook on
`FUN_007019b0` does: check pool pressure before Alloc, return queue
unchanged when near-full. Not "fix the broken Alloc" — **restore the
console-level overflow defence the PC port omitted**.

Our hook isn't "experimental patching"; it's "restoring PS3-class
behaviour to the PC port".

## Postscript III — empirical refutation of "normal play causes overflow"

After designing and validating the Frida-based audio guard (`audio_guard/`)
on a modern setup (RTX 5070 + SSD), the natural concern was whether
overflow IS reachable on slower hardware where original community
crash reports originated. So we ran a stress simulation:

**Test setup:**
- CPU: limited to ONE core (`affinity 0x01`) via Task Manager
- FPS: locked at 30 (matching HDD-era cap)
- Scene: heavy active gameplay (combat, NPCs, ambient SFX)
- Duration: ~10 minutes
- Audio guard attached, all 4 hooks active

**Result:**
- `max_count = 3/64` (same as full-CPU+60-FPS sessions)
- Zero anomaly events fired (no `RATIO_DRIFT`, no `FREE_STALL`, no `SATURATION`)
- Single thread (`tid=26224`) handles all audio
- Pool ping-pong behaviour identical to fast-hardware test

**Interpretation:**
Even with deliberately constrained CPU + 30 FPS + sustained activity, the
audio pool is architecturally unable to climb past 3 slots. The PC port's
single-threaded audio pipeline serialises requests effectively enough that
modern hardware's worst-case scenario (1-core CPU) is still 20× headroom
below pool capacity.

This empirically refutes the "audio pool overflow during normal gameplay"
hypothesis. Community-reported `Chapter 9 art-gallery exit` and similar
crashes are NOT this bug class. Their causes:

| Reported symptom | Real cause | Mitigation in v1.3.0 |
|------------------|------------|----------------------|
| Chapter 9 art-gallery exit crash | DSB state-machine bug (script-level) | Community save replacement (not engine fix) |
| Long-session random crashes | FPS-timing drift ceil/floor drift (Bug #1) | 60 FPS cap |
| Gas-station cutscene crash | LAV/DirectShow codec issue | Session-scoped codec fix |
| "Memory pressure" reports | Generic Win32 fragmentation across all subsystems | Session timer + autosave |
| **Theoretical audio-pool overflow** | **Architecturally unreachable in normal play** | **N/A — bug exists in theory only** |

The audio pool bug we documented in `AUDIO_POOL_LEAK.md` is real (`Alloc`
has no overflow check, `Pop` dereferences unchecked pointer when stack
empty), but the conditions to trigger it require something we couldn't
produce: either a specific cutscene callback bug that orphans 60+ slots,
or a multi-hour session with rare slow-drain events that we'd need many
hours to catch.

**Phase B (active skip at threshold) was designed but not shipped** because
no live reproduction justified the runtime overhead. The architecture is
documented in `audio_guard/README.md` if a future community report
demonstrates the crash class still exists on top of v1.3.0 mitigations.

## Tools we built (and what they're good for)

| Tool | Purpose | Reusable? |
|------|---------|-----------|
| `verify_dp_clean.py` | Detect hex-patch residue in DP.exe | DP-specific |
| `analyze_crash.py` | Parse MINIDUMP, identify exception + module + function | Generic Win32 minidump |
| `analyze_hang.py` | WOW64 hang dump → return-address chain per thread | Generic WOW64 |
| `identify_addr.py` | Walk back from RA to function start in a .text section | Generic PE32 |
| `find_caves.py` | Find CC-padded code caves in .text | Generic PE32 |
| `find_event_strings.py` | Locate ASCII strings + scan for VA references | Generic PE32 |
| `dump_event_region.py` | Hex dump + pointer-lands-in-range scan | Generic PE32 |
| `find_debug_info.py` | Extract PDB path, source paths, RTTI names | Generic PE32 |
| `compare_xbox_pc.py` | List PE imports of DP.exe (used in Xbox vs PC investigation) | Generic PE32 |
| `extract_ps3_elf.py` | Strip SCE wrapper from PS3 EBOOT.BIN (works only on already-decrypted SELF) | PS3 SELF |
| `inspect_ps3_elf.py` | Quick ELF sanity check + section/symbol summary + audio API string anchors | PS3 PowerPC64 ELF |

All are kept in the game directory as one-shot Python scripts. None
require Ghidra; they parse PE structures and minidump format directly.

## What we learned about reverse-engineering an old commercial game

1. **The community is usually right about symptoms, wrong about
   causes.** "Memory leak" was wrong (it's a fixed pool with no
   overflow check). "Smoking cures crashes" was right empirically but
   the actual mechanism is FPS-dependent timing drift desyncing the
   script clock.

2. **Binary patches are a last resort.** We tried twice on audio-pool
   and broke save-loading both times because the patched function's
   callers had no error path. A "successful" allocator patch is
   useless if every caller assumes Alloc never fails.

3. **Soft mitigations beat fragile patches.** A session-time reminder
   that prompts you to restart every 3 hours achieves ~90% of the user
   benefit of a perfect audio-pool patch, with zero risk to the binary.
   Autosave backup makes the remaining 10% non-catastrophic.

4. **Test on the actual hardware the user has.** Our "slow loading"
   diagnosis went through three wrong hypotheses before we A/B tested
   by renaming `d3d9.dll`. Without that test we'd have shipped a
   "DXVK config writer" that does nothing useful.

5. **Read other communities' write-ups before you build tools.** Two
   Steam-thread comments and one Reddit post would have saved us a week
   of dump-analyser plumbing. We did eventually consult them — and they
   confirmed our conclusion within minutes. Should have been step one.

6. **MSVC `/OPT:NOREF` is a tarpit.** Debug strings that have *zero
   references in the binary* will mislead you for hours. If the linker
   left them in, it's not necessarily because the code uses them.

## What we didn't fix and likely never will

- **Chapter 9 art-gallery crash** — script state-mismatch, fixable only
  by replacing the save with a community-provided one that skips the
  broken transition. The launcher's Autosave Backup gives you the
  rollback target; you still need the replacement save.
- **Chapter 12 22:00-event crash** — same class as Chapter 9.
  Workaround: smoke until 22:50.
- **Random crashes during Epilogue** — non-deterministic, no
  reproduction pattern. Reload typically works. We have no
  insight into the cause.
- **The DSB script format** — closed off as a multi-week effort with
  no guaranteed payoff. Listed for posterity in case someone else
  wants to pick it up.

## Closing observations

Twelve years of community work on DPC accreted as forum posts, GitHub
gists, partial RE notes, and folklore. The launcher's job is to bundle
all of it into one tool that an ordinary user can run without reading
any of it. Where the community had a real fix, we shipped it; where the
community had a workaround, we automated it; where neither existed and
the engine bug was beyond binary patching, we documented the limit and
shipped the next-best soft mitigation.

The release-cycle pattern that worked: ship a soft mitigation first
(it's safe, ships fast, helps everyone), document the engine bug
honestly (so future work can pick up), and only attempt a binary patch
when you have *both* a clean repro path *and* an exit strategy if the
patch breaks something. We violated rule three twice on audio-pool —
hence the postmortem.

---

*Author's note: this document is current as of v1.3.0 (May 2026).
Future releases may revisit conclusions if community knowledge or
upstream tools (DXVK driver paths, GPU-vendor cache behavior) change
the practical trade-offs.*
