# NaN Hang Guard — Chapter 3 spin-loop fix

**Status:** experimental, v1.5.0
**Severity:** main thread infinite loop → AppHang ("Not Responding")
**Trigger:** internal float helper inside `DP.exe` receives a NaN value
**Fix:** 2-byte runtime patch to `DP.exe` (reversible, sidecar-tracked)

## TL;DR

A user-supplied Task Manager dump from Chapter 3 captured `DP.exe` deadlocked
with the main thread at `EIP = 0x00409EA6`. Disassembly of that address
revealed a deliberate `jmp $` infinite-loop assertion guarding an internal
float helper. The bad input — `0xFFC00000` — is a negative quiet NaN
propagating into game state during a loading transition after a cutscene.

The patch replaces the `EB FE` (jmp $) with `90 90` (two NOPs) so the assert
falls through to the existing `fldz` path. Result: the function returns
`0.0f` for invalid input instead of hanging the thread.

## The original code

```
00409EA2  85 C0     test  eax, eax
00409EA4  74 02     je    00409EA8        ; eax == 0 → safe path
00409EA6  EB FE     jmp   00409EA6        ; eax != 0 → spin forever
00409EA8  D9 EE     fldz                  ; load 0.0f
00409EAA  ...                             ; return
```

The validation flag in `eax` is **expected** to be zero. When it isn't, the
code spins forever — a classic "this can never happen" guard. Except it does
happen, in the wild, during specific game-state transitions.

## What we observed in the dump

* Main thread `TID 0x8B10`, `EIP = 0x00409EA6`
* Stack chain pointed to `DP.exe + 0x0D4EC9` ← caller of the float helper
* Suspicious actor/object @ `0x42BE08E8`:
  * `+0x1058` = `0xFFC00000` ← **qNaN** — the bad input
  * `+0x105C` ≈ `1.2500003` ← plausible value
  * `+0x1060` ≈ `0.3333334` ← plausible value
* No other thread was in the same function range
* No exception stream (pure AppHang, not a crash)

The NaN very likely originates from a divide-by-zero or a `0/0` derived from
animation timing / camera math during a scripted transition.

## The patch

```
File offset:  0x000092A6        (.text section, raw data)
Virtual addr: 0x00409EA6        (image base 0x00400000 + .text VA 0x1000 + …)
Original:     EB FE              (jmp short -2 = jmp $)
Patched:      90 90              (nop ; nop)
Size delta:   0 bytes
```

After the patch:

```
00409EA2  85 C0     test  eax, eax
00409EA4  74 02     je    00409EA8        ; (unchanged)
00409EA6  90        nop                    ; (was EB)
00409EA7  90        nop                    ; (was FE)
00409EA8  D9 EE     fldz                   ; reached via je OR fall-through
```

Both branches now reach `fldz`. The function returns `0.0f` regardless of
the validity flag — effectively turning "should never happen" into "treat
invalid input as zero".

## Why patch + nops, not a code cave or runtime injection

* The patch is byte-for-byte identical in size to the original.
* No relocation, no relative-jump rewriting, no IAT impact.
* No DLL injection or `WriteProcessMemory` plumbing required.
* Steam will detect the modified `DP.exe` during *Verify integrity of game
  files* and silently re-download a clean copy, providing a built-in escape
  hatch.
* The launcher refuses to patch if `DP.exe` is currently running.

## Pattern matching

The launcher does **not** blind-patch at a hardcoded offset. It first
locates the 8-byte signature inside the `.text` section:

```
85 C0 74 02 EB FE D9 EE
   |    |   |    |
   |    |   |    +-- fldz (the safe path)
   |    |   +------- jmp $ (the bug)
   |    +----------- je +2
   +---------------- test eax, eax
```

This pattern is **unique** in `DP.exe`: a scan of all 8,224,256 bytes finds
exactly one match. The patcher refuses to act if the match count is 0
(unsupported binary) or > 1 (ambiguous — refuse rather than guess).

A SHA-256 of the binary is also recorded; the known-good Steam build hash is

```
4118eae94bc6f2f584d206a7dd813a3d8ae14f6348e89d5d951d8765a5d81fa6
```

If your DP.exe SHA-256 differs, the patch may still succeed *if* the pattern
matches (other Steam delta-patches could change unrelated bytes), but the
user is warned in the UI.

## Revert

Patch state is tracked via a sidecar `DP.exe.nanguard.json` next to the
binary:

```json
{
  "name": "DP1 Launcher / Experimental NaN Hang Guard",
  "version": 1,
  "appliedAt": "2026-05-27T19:21:00.000Z",
  "target": {
    "fileOffset": 37542,
    "va": 4234918,
    "original": "EB FE",
    "patched":  "90 90"
  },
  "sha256": {
    "before": "4118eae94bc6f2f584d206a7dd813a3d8ae14f6348e89d5d951d8765a5d81fa6",
    "after":  "51ea07ae8aab7e97c534858193daaefa031b168fa695083d71f1ef1486e00d7f"
  },
  "note": "Reversible via DP1 Launcher → Settings → Stability → NaN Hang Guard → Revert"
}
```

`Revert` reads the sidecar, verifies the bytes at the recorded offset still
match the patched pattern, writes back `EB FE`, and deletes the sidecar.

If the sidecar is missing (user deleted it, machine migration), `Revert`
still works via pattern detection — it searches for the patched 8-byte
signature `85 C0 74 02 90 90 D9 EE` and uses that offset.

## Scope of the fix

This patch addresses **one specific class** of Chapter 3 hang:
* NaN propagation → float helper assert → infinite loop on main thread.

It does **not** address:
* XAudio2 / PhysX cross-DLL deadlocks (dump #2 signature) — those need
  different mitigations (Steam Overlay off, CPU affinity, or AMD legacy
  driver bypass via DXVK).
* Legacy AMD/Intel D3D9 driver deadlocks (dump #3 signature) — switch to
  the **DPfix + DXVK** preset to route D3D9 calls through Vulkan,
  bypassing `AMDXN32.DLL` and similar driver paths entirely.

If users still hang after applying this patch, the launcher's
**Settings → Stability → GPU Driver Compatibility** card now surfaces a
DXVK preset recommendation for legacy GPUs.

## Implementation files

| File                              | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `workers/nan_guard.js`            | PE parser, pattern scan, apply/revert primitives |
| `main.js` (IPC handlers)          | `nan-guard-status` / `apply` / `revert`          |
| `preload.js`                      | `nanGuardStatus/Apply/Revert` API                |
| `src/index.html` (Stability tab)  | UI accordion + buttons                           |
| `src/renderer.js`                 | Status refresh + apply/revert click handlers     |
| `loc/eng.json` / `loc/ukr.json`   | i18n strings                                     |

## Future work

A native runtime injector (small C++ helper that spawns `DP.exe` suspended,
patches via `WriteProcessMemory`, then `ResumeThread`) would avoid touching
the on-disk binary entirely. That's the spec-preferred approach but requires
adding a C++ build step to the project. Current static-patch approach is
consistent with existing `4gb_patch.exe` and DPfix `d3d9.dll` patches and
ships in v1.5.0 to validate the fix in the wild before any further
engineering investment.
