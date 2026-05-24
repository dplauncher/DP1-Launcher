"""
DP1 Audio Guard — Frida prototype, Phase A v5 (corrected hook semantics)
─────────────────────────────────────────────────────────────────────────

v5 corrects a misidentification in v4: FUN_00704130 is NOT Pop, it is
TPopList::Push (called by Free). Push has signature `void Push(TPopList*,
int idx)` and returns void. Its EAX after-return is leftover, not a
meaningful pointer — that produced the false-positive "INVALID_IDX_POP"
warnings.

Hook map (v5):
  Enqueue (FUN_007019b0 @ 0x007019B0) — pool.count++, push idx to queue
  Free    (FUN_00703a50 @ 0x00703A50) — pool.count--, return slot to free stack
  Alloc   (FUN_007039f0 @ 0x007039F0) — pool.count++, returns allocated idx
  Push    (FUN_00704130 @ 0x00704130) — TPopList::Push, returns void.
                                        Called from inside Free with idx
                                        to return to free-stack.

Real Pop address: NOT YET KNOWN. Pop is called from inside Alloc.
To find it: disassemble Alloc, locate the first CALL after the
EnterCriticalSection prologue. Until then we validate Alloc results
indirectly via in_use[] diff (snapshot in_use array before Alloc, find
which byte changed after Alloc → that's the actual allocated idx).

Pool layout (validated):
  +0x0000  vftable
  +0x0004  count : uint32_t
  +0x0008  in_use[64] : bool         ← 64 bytes, one per slot
  +0x0048  free_idx : TPopList<uint, 64>
  +0x0154  items[64]
"""

import sys
import time
import signal

try:
    import frida
except ImportError:
    print("[!] frida not installed. Run: pip install frida frida-tools")
    sys.exit(1)


ENQUEUE_VA       = 0x007019B0
FREE_VA          = 0x00703A50
ALLOC_VA         = 0x007039F0
PUSH_VA          = 0x00704130  # TPopList::Push (NOT Pop — Pop is TBD)
DP_IMAGE_BASE    = 0x00400000

POOL_OFFSET      = 0x1070
COUNT_OFFSET     = 0x0004
IN_USE_OFFSET    = 0x0008
FREE_IDX_OFFSET  = 0x0048
POOL_CAPACITY    = 64

QUIET_COUNT_MAX     = 8
COUNT_THRESHOLDS    = [8, 16, 32, 48, 60]
RATIO_DRIFT_LIMIT   = 1.10
FREE_STALL_SECONDS  = 10
PERIODIC_INTERVAL_S = 30


JS_PAYLOAD = r"""
const ENQUEUE_VA      = ptr(0x007019B0);
const FREE_VA         = ptr(0x00703A50);
const ALLOC_VA        = ptr(0x007039F0);
const PUSH_VA         = ptr(0x00704130);
const DP_IMAGE_BASE   = ptr(0x00400000);
const POOL_OFFSET     = 0x1070;
const COUNT_OFFSET    = 0x04;
const IN_USE_OFFSET   = 0x08;
const FREE_IDX_OFFSET = 0x48;
const POOL_CAPACITY   = 64;
const QUIET_COUNT_MAX     = 8;
const COUNT_THRESHOLDS    = [8, 16, 32, 48, 60];
const RATIO_DRIFT_LIMIT   = 1.10;
const FREE_STALL_SECONDS  = 10;
const PERIODIC_INTERVAL_S = 30;

const dp = Process.findModuleByName('DP.exe');
if (!dp) {
    send({ kind: 'fatal', msg: 'DP.exe module not found' });
} else {
    const enqueueTarget = dp.base.add(ENQUEUE_VA.sub(DP_IMAGE_BASE));
    const freeTarget    = dp.base.add(FREE_VA.sub(DP_IMAGE_BASE));
    const allocTarget   = dp.base.add(ALLOC_VA.sub(DP_IMAGE_BASE));
    const pushTarget    = dp.base.add(PUSH_VA.sub(DP_IMAGE_BASE));
    const dpStart = dp.base;
    const dpEnd   = dp.base.add(dp.size);
    const inDp = (p) => {
        try { return p.compare(dpStart) >= 0 && p.compare(dpEnd) < 0; }
        catch (e) { return false; }
    };

    send({
        kind: 'init',
        dp_base: dp.base.toString(),
        enqueue_target: enqueueTarget.toString(),
        free_target:    freeTarget.toString(),
        alloc_target:   allocTarget.toString(),
        push_target:    pushTarget.toString()
    });

    // ─── State ─────────────────────────────────────────────────────────
    let enqueueHits = 0, freeHits = 0, allocHits = 0, pushHits = 0;
    let maxCountSeen = 0;
    let lastFreeTime = Date.now();
    let lastKnownCount = 0;
    let lastPoolAddr = null;
    let lastFreeIdx = -1;   // for Push <-> Free correlation
    const seenCallers = new Set();
    const seenThreads = new Set();
    const crossedThresholds = new Set();
    let lastEnqAtSample = 0, lastFreAtSample = 0;
    let stallNotified = false, ratioDriftNotified = false;
    // Track count history for real-leak detection (vs long-held BGM slot)
    let stallBaselineCount = -1;
    let stallBaselineEnq = 0, stallBaselineFre = 0;

    // ─── Hook 1: Enqueue ──────────────────────────────────────────────
    Interceptor.attach(enqueueTarget, {
        onEnter: function() {
            enqueueHits++;
            const thisp    = this.context.ecx;
            const esp      = this.context.esp;
            const retAddr  = esp.readU32();
            const queue    = esp.add(0x4).readU32();
            const soundDat = esp.add(0x8).readU32();
            const tid      = Process.getCurrentThreadId();
            const poolAddr    = thisp.add(POOL_OFFSET);
            const countBefore = poolAddr.add(COUNT_OFFSET).readU32();

            if (!seenCallers.has(retAddr)) {
                seenCallers.add(retAddr);
                send({ kind: 'new_caller', where: 'enqueue',
                       addr: '0x' + retAddr.toString(16),
                       in_dp: inDp(ptr(retAddr)),
                       enqueue_hit: enqueueHits });
            }
            if (!seenThreads.has(tid)) {
                seenThreads.add(tid);
                send({ kind: 'new_thread', where: 'enqueue', tid: tid,
                       enqueue_hit: enqueueHits });
            }

            this.hitNum = enqueueHits;
            this.thisp = thisp; this.poolAddr = poolAddr;
            this.countBefore = countBefore;
            this.retAddr = retAddr; this.queue = queue;
            this.soundDat = soundDat; this.tid = tid;
        },
        onLeave: function() {
            const countAfter = this.poolAddr.add(COUNT_OFFSET).readU32();
            const delta = countAfter - this.countBefore;
            if (countAfter > maxCountSeen) maxCountSeen = countAfter;
            lastKnownCount = countAfter;
            lastPoolAddr = this.poolAddr;

            for (const t of COUNT_THRESHOLDS) {
                if (countAfter >= t && !crossedThresholds.has(t)) {
                    crossedThresholds.add(t);
                    send({ kind: 'threshold_cross', threshold: t,
                           count_after: countAfter,
                           enqueue_hit: this.hitNum, tid: this.tid,
                           caller: '0x' + this.retAddr.toString(16) });
                }
            }

            const noisy = (this.hitNum <= 10) || (countAfter >= QUIET_COUNT_MAX);
            if (noisy) {
                send({ kind: 'enqueue', n: this.hitNum, tid: this.tid,
                       thisp: this.thisp.toString(),
                       pool: this.poolAddr.toString(),
                       count_before: this.countBefore,
                       count_after: countAfter, delta: delta,
                       queue: '0x' + this.queue.toString(16),
                       sound_data: '0x' + this.soundDat.toString(16),
                       ret_addr: '0x' + this.retAddr.toString(16),
                       ret_in_dp: inDp(ptr(this.retAddr)),
                       high: countAfter >= QUIET_COUNT_MAX });
            }
        }
    });

    // ─── Hook 2: Free ─────────────────────────────────────────────────
    Interceptor.attach(freeTarget, {
        onEnter: function() {
            freeHits++;
            const pool    = this.context.ecx;
            const esp     = this.context.esp;
            const retAddr = esp.readU32();
            const idx     = esp.add(0x4).readU32();
            const tid     = Process.getCurrentThreadId();

            if (!seenCallers.has(retAddr)) {
                seenCallers.add(retAddr);
                send({ kind: 'new_caller', where: 'free',
                       addr: '0x' + retAddr.toString(16),
                       in_dp: inDp(ptr(retAddr)), free_hit: freeHits });
            }
            if (!seenThreads.has(tid)) {
                seenThreads.add(tid);
                send({ kind: 'new_thread', where: 'free', tid: tid,
                       free_hit: freeHits });
            }

            const countBefore = pool.add(COUNT_OFFSET).readU32();
            this.hitNum = freeHits; this.pool = pool;
            this.idx = idx; this.countBefore = countBefore;
            this.tid = tid; this.retAddr = retAddr;
            lastFreeTime = Date.now();
            stallNotified = false;
            lastFreeIdx = idx;   // for Push correlation
        },
        onLeave: function() {
            const countAfter = this.pool.add(COUNT_OFFSET).readU32();
            lastKnownCount = countAfter;
            if (this.idx >= POOL_CAPACITY) {
                send({ kind: 'invalid_idx_free', n: this.hitNum,
                       idx: this.idx, pool: this.pool.toString() });
            }
            const noisy = (this.hitNum <= 10) || (this.countBefore >= QUIET_COUNT_MAX);
            if (noisy) {
                send({ kind: 'free', n: this.hitNum, tid: this.tid,
                       pool: this.pool.toString(), idx: this.idx,
                       count_before: this.countBefore,
                       count_after: countAfter,
                       delta: countAfter - this.countBefore,
                       ret_addr: '0x' + this.retAddr.toString(16),
                       ret_in_dp: inDp(ptr(this.retAddr)) });
            }
        }
    });

    // ─── Hook 3: Alloc (with in_use[] diff for real-idx discovery) ────
    Interceptor.attach(allocTarget, {
        onEnter: function() {
            allocHits++;
            const pool = this.context.ecx;
            const countBefore = pool.add(COUNT_OFFSET).readU32();
            // Snapshot in_use[0..63] before Alloc
            const inUseBefore = pool.add(IN_USE_OFFSET).readByteArray(64);
            this.allocPool = pool;
            this.allocBefore = countBefore;
            this.allocN = allocHits;
            this.inUseBefore = inUseBefore;

            if (countBefore >= POOL_CAPACITY) {
                send({ kind: 'saturation', n: allocHits,
                       pool: pool.toString(),
                       count_before: countBefore });
            }
        },
        onLeave: function(retval) {
            const eax = retval.toUInt32 ? retval.toUInt32() : 0;
            const countAfter = this.allocPool.add(COUNT_OFFSET).readU32();
            // Compare in_use[] before/after to find which slot got marked
            const inUseAfter = this.allocPool.add(IN_USE_OFFSET).readByteArray(64);
            const before = new Uint8Array(this.inUseBefore);
            const after  = new Uint8Array(inUseAfter);
            let changedSlot = -1;
            for (let i = 0; i < 64; i++) {
                if (before[i] !== after[i]) { changedSlot = i; break; }
            }

            // Cross-validate: eax (Alloc's nominal return) vs changedSlot
            const eaxValid = (eax < POOL_CAPACITY);
            const slotValid = (changedSlot >= 0 && changedSlot < POOL_CAPACITY);
            const consistent = eaxValid && slotValid && (eax === changedSlot);

            if (!eaxValid && !slotValid) {
                // Both broken — likely real overflow
                send({ kind: 'alloc_broken', n: this.allocN,
                       eax: eax, in_use_diff_slot: changedSlot,
                       count_before: this.allocBefore,
                       count_after: countAfter });
            } else if (eaxValid && !slotValid) {
                // EAX looks fine but no in_use change — strange
                send({ kind: 'alloc_eax_only', n: this.allocN,
                       eax: eax, count_before: this.allocBefore,
                       count_after: countAfter });
            } else if (!eaxValid && slotValid) {
                // EAX garbage but in_use[changedSlot] flipped — overflow signature
                send({ kind: 'alloc_inuse_only', n: this.allocN,
                       eax: eax, in_use_diff_slot: changedSlot,
                       count_before: this.allocBefore,
                       count_after: countAfter });
            } else if (eaxValid && slotValid && !consistent) {
                send({ kind: 'alloc_mismatch', n: this.allocN,
                       eax: eax, in_use_diff_slot: changedSlot });
            }

            // Sanity log for first 5 hits
            if (this.allocN <= 5) {
                send({ kind: 'alloc', n: this.allocN,
                       pool: this.allocPool.toString(),
                       eax: eax, in_use_diff_slot: changedSlot,
                       consistent: consistent,
                       count_before: this.allocBefore,
                       count_after: countAfter });
            }
        }
    });

    // ─── Hook 4: Push (TPopList::Push) — returns void ─────────────────
    // Signature TBD — strong evidence so far: __thiscall + by-pointer:
    //   void Push(TPopList* this, const int* p_idx)
    // ECX = this, [esp+4] = pointer to int containing idx.
    // We DO NOT warn — we log raw arg + try multiple interpretations.
    // Correlation: most-recent Free's idx should equal *raw_arg if signature
    // is the by-pointer variant.
    Interceptor.attach(pushTarget, {
        onEnter: function() {
            pushHits++;
            const popList  = this.context.ecx;
            const esp      = this.context.esp;
            const tid      = Process.getCurrentThreadId();
            const edxVal   = this.context.edx.toUInt32 ?
                             this.context.edx.toUInt32() :
                             parseInt(this.context.edx.toString());

            // Raw stack values
            const stack0 = esp.readU32();           // return addr
            const stack1 = esp.add(0x4).readU32();  // raw_arg (first stack slot)
            const stack2 = esp.add(0x8).readU32();
            const stack3 = esp.add(0xC).readU32();

            // Try to deref raw_arg as a pointer to int (by-pointer signature)
            let derefStack1 = null;
            try { derefStack1 = ptr(stack1).readU32(); } catch (e) {}
            let derefEdx = null;
            try { derefEdx = ptr(edxVal).readU32(); } catch (e) {}

            // Pick the most likely interpretation
            let idx = -1, interpretation = 'unknown';
            if (stack1 >= 0 && stack1 < POOL_CAPACITY) {
                idx = stack1; interpretation = 'by-value [esp+4] (__thiscall)';
            } else if (derefStack1 !== null && derefStack1 < POOL_CAPACITY) {
                idx = derefStack1; interpretation = 'by-pointer *[esp+4]';
            } else if (edxVal < POOL_CAPACITY) {
                idx = edxVal; interpretation = 'by-value EDX (__fastcall)';
            } else if (derefEdx !== null && derefEdx < POOL_CAPACITY) {
                idx = derefEdx; interpretation = 'by-pointer *EDX';
            }

            // Cross-check vs most-recent Free idx
            const matchesLastFree = (lastFreeIdx >= 0 && idx === lastFreeIdx);

            // Warn ONLY if ALL candidates failed
            if (idx === -1) {
                send({ kind: 'invalid_idx_push', n: pushHits,
                       edx: edxVal, esp4: stack1, esp8: stack2,
                       deref_stack1: derefStack1, deref_edx: derefEdx,
                       pool_list: popList.toString() });
            }

            // Log first 10 pushes with full diagnostic
            if (pushHits <= 10) {
                send({ kind: 'push', n: pushHits,
                       pool_list: popList.toString(),
                       last_free_idx: lastFreeIdx,
                       interpretation: interpretation,
                       idx_resolved: idx,
                       matches_last_free: matchesLastFree,
                       raw: {
                           ecx: popList.toString(),
                           edx: '0x' + edxVal.toString(16),
                           esp: esp.toString(),
                           stack0_ret: '0x' + stack0.toString(16),
                           stack1_arg: '0x' + stack1.toString(16),
                           stack2:     '0x' + stack2.toString(16),
                           stack3:     '0x' + stack3.toString(16),
                           deref_stack1: derefStack1 !== null ? derefStack1 : 'unreadable',
                           deref_edx:    derefEdx    !== null ? derefEdx    : 'unreadable'
                       },
                       tid: tid });
            }
        }
        // No onLeave — Push returns void
    });

    // ─── Periodic heartbeat + watchdogs ───────────────────────────────
    setInterval(() => {
        const secsSinceFree = Math.floor((Date.now() - lastFreeTime) / 1000);
        const enqInWindow = enqueueHits - lastEnqAtSample;
        const freInWindow = freeHits - lastFreAtSample;
        lastEnqAtSample = enqueueHits;
        lastFreAtSample = freeHits;
        const rollingRatio = freInWindow > 0
            ? (enqInWindow / freInWindow)
            : (enqInWindow > 0 ? Infinity : 1.0);

        if (!ratioDriftNotified && enqInWindow >= 20 &&
            rollingRatio !== Infinity && rollingRatio > RATIO_DRIFT_LIMIT) {
            ratioDriftNotified = true;
            send({ kind: 'ratio_drift', window_enq: enqInWindow,
                   window_fre: freInWindow,
                   rolling_ratio: rollingRatio.toFixed(3),
                   total_enq: enqueueHits, total_fre: freeHits });
        }
        if (ratioDriftNotified && rollingRatio <= 1.05) ratioDriftNotified = false;

        // FREE_STALL: real-leak detection. We must distinguish:
        //   (a) BGM/ambient holding 1 stable slot — normal multi-channel audio
        //   (b) accumulating orphan slots — actual leak
        //
        // Strategy: take a baseline when count first goes >0, then warn only
        // if either:
        //   - count GROWS above baseline during stall (more slots accumulate)
        //   - OR global imbalance (enq_total - fre_total) GROWS over time
        //
        // A constant count>0 with balanced enq/fre after baseline is the
        // BGM pattern — silent.

        if (lastKnownCount > 0 && stallBaselineCount < 0) {
            // Establish baseline when count first becomes non-zero
            stallBaselineCount = lastKnownCount;
            stallBaselineEnq   = enqueueHits;
            stallBaselineFre   = freeHits;
        }
        if (lastKnownCount === 0) {
            // Pool fully drained — clear baseline + reset notification
            stallBaselineCount = -1;
            stallNotified = false;
        }

        // Real leak signature: count grew above baseline since stall started
        const countGrew = stallBaselineCount >= 0 && lastKnownCount > stallBaselineCount;
        const imbalanceGrew = stallBaselineCount >= 0 &&
            (enqueueHits - freeHits) > (stallBaselineEnq - stallBaselineFre);

        if (!stallNotified && secsSinceFree >= FREE_STALL_SECONDS &&
            (countGrew || imbalanceGrew)) {
            stallNotified = true;
            send({ kind: 'free_stall', secs_since_free: secsSinceFree,
                   window_enqueues: enqInWindow,
                   last_known_count: lastKnownCount,
                   baseline_count: stallBaselineCount,
                   enq_total: enqueueHits, fre_total: freeHits,
                   reason: countGrew
                           ? `count grew ${stallBaselineCount}→${lastKnownCount}`
                           : 'imbalance growing (enq>>fre over time)' });
        }

        if (lastPoolAddr) {
            try {
                const liveCount = lastPoolAddr.add(COUNT_OFFSET).readU32();
                if (liveCount !== lastKnownCount && liveCount <= POOL_CAPACITY) {
                    const delta = liveCount - lastKnownCount;
                    send({ kind: 'ghost_delta',
                           last_hook_count: lastKnownCount,
                           live_count: liveCount, delta: delta });
                    lastKnownCount = liveCount;
                }
            } catch (e) {}
        }

        send({ kind: 'heartbeat',
               enq: enqueueHits, fre: freeHits,
               alloc: allocHits, push: pushHits,
               max_count: maxCountSeen,
               secs_since_free: secsSinceFree,
               rolling_ratio: !isFinite(rollingRatio) ? 'inf' :
                              (isNaN(rollingRatio) ? '-' : rollingRatio.toFixed(2)),
               threads: Array.from(seenThreads),
               n_callers: seenCallers.size,
               thresholds_crossed: Array.from(crossedThresholds) });
    }, PERIODIC_INTERVAL_S * 1000);
}
"""


def on_message(msg, data):
    if msg['type'] == 'error':
        print(f"[!] frida error: {msg.get('description', msg)}")
        if msg.get('stack'): print(msg['stack'])
        return

    p = msg.get('payload', {})
    k = p.get('kind')

    if k == 'fatal':
        print(f"[FATAL] {p['msg']}")

    elif k == 'init':
        print(f"[+] hooks installed (4 targets):")
        print(f"    Enqueue (FUN_007019b0) = {p['enqueue_target']}")
        print(f"    Free    (FUN_00703a50) = {p['free_target']}")
        print(f"    Alloc   (FUN_007039f0) = {p['alloc_target']}")
        print(f"    Push    (FUN_00704130) = {p['push_target']}  ← was misidentified as Pop in v4")
        print(f"    Real Pop address: TBD (inside Alloc — disasm needed)")
        print(f"    Alloc validates idx via in_use[] before/after diff")
        print(f"    Quiet mode: per-hit silent while count<{QUIET_COUNT_MAX}, balance OK")
        print()

    elif k == 'enqueue':
        mark = '⚠ HIGH' if p['high'] else ''
        print(f"[ENQ #{p['n']:04d} tid={p['tid']:5d}] this={p['thisp']} pool={p['pool']} "
              f"count {p['count_before']:2d}→{p['count_after']:2d} (+{p['delta']}) "
              f"ret={p['ret_addr']} {mark}")
    elif k == 'free':
        print(f"[FRE #{p['n']:04d} tid={p['tid']:5d}] pool={p['pool']} idx={p['idx']:3d} "
              f"count {p['count_before']:2d}→{p['count_after']:2d} ret={p['ret_addr']}")
    elif k == 'alloc':
        ok = '✓' if p['consistent'] else '⚠'
        print(f"[ALC #{p['n']:04d}] pool={p['pool']} eax={p['eax']} "
              f"in_use_diff={p['in_use_diff_slot']} {ok} "
              f"count {p['count_before']}→{p['count_after']}")
    elif k == 'push':
        match_mark = '✓' if p['matches_last_free'] else '?'
        print(f"[PSH #{p['n']:04d} tid={p['tid']:5d}] pool_list={p['pool_list']} "
              f"idx={p['idx_resolved']} (via {p['interpretation']}) "
              f"vs lastFree={p['last_free_idx']} {match_mark}")
        r = p['raw']
        print(f"           ECX={r['ecx']} EDX={r['edx']} ESP={r['esp']}")
        print(f"           stack0_ret={r['stack0_ret']} stack1={r['stack1_arg']} "
              f"stack2={r['stack2']} stack3={r['stack3']}")
        print(f"           deref[esp+4]={r['deref_stack1']} deref[edx]={r['deref_edx']}")

    elif k == 'new_caller':
        print(f"  ▸ NEW_CALLER ({p['where']}): {p['addr']} {'✓DP' if p['in_dp'] else '✗ext'}")
    elif k == 'new_thread':
        print(f"  ▸ NEW_THREAD ({p['where']}): tid={p['tid']}")
    elif k == 'threshold_cross':
        print(f"  ▸ THRESHOLD_CROSS: count reached {p['threshold']} "
              f"(now {p['count_after']}) hit#{p['enqueue_hit']} tid={p['tid']} caller={p['caller']}")
    elif k == 'ratio_drift':
        print(f"  ⚠ RATIO_DRIFT: window enq/fre = {p['rolling_ratio']} "
              f"({p['window_enq']}/{p['window_fre']}) total={p['total_enq']}/{p['total_fre']}")
    elif k == 'free_stall':
        print(f"  ⚠ FREE_STALL: no Free for {p['secs_since_free']}s — REAL LEAK SIGNAL")
        print(f"           reason: {p['reason']}")
        print(f"           baseline_count={p['baseline_count']} count_now={p['last_known_count']}")
        print(f"           enq_total={p['enq_total']} fre_total={p['fre_total']}")
    elif k == 'saturation':
        print(f"  ⚠ SATURATION: Alloc#{p['n']} called when count_before={p['count_before']} >= 64")
    elif k == 'alloc_broken':
        print(f"  ⚠ ALLOC_BROKEN: #{p['n']} eax={p['eax']} in_use_slot={p['in_use_diff_slot']} — both broken")
    elif k == 'alloc_inuse_only':
        print(f"  ⚠ ALLOC_INUSE_ONLY: #{p['n']} eax={p['eax']} (garbage) but in_use[{p['in_use_diff_slot']}] flipped")
    elif k == 'alloc_eax_only':
        print(f"  ⚠ ALLOC_EAX_ONLY: #{p['n']} eax={p['eax']} (looks valid) but no in_use change")
    elif k == 'alloc_mismatch':
        print(f"  ⚠ ALLOC_MISMATCH: #{p['n']} eax={p['eax']} != in_use_diff_slot={p['in_use_diff_slot']}")
    elif k == 'invalid_idx_push':
        print(f"  ⚠ INVALID_IDX_PUSH: #{p['n']} — ALL candidates failed")
        print(f"           EDX={p['edx']} [esp+4]={p['esp4']} [esp+8]={p['esp8']}")
        print(f"           *[esp+4]={p['deref_stack1']} *EDX={p['deref_edx']}")
        print(f"           pool_list={p['pool_list']}")
    elif k == 'invalid_idx_free':
        print(f"  ⚠ INVALID_IDX_FREE: #{p['n']} idx={p['idx']} pool={p['pool']}")
    elif k == 'ghost_delta':
        print(f"  ⚠ GHOST_DELTA: count {p['last_hook_count']} → {p['live_count']} (Δ{p['delta']})")

    elif k == 'heartbeat':
        print(f"  ── HB: enq={p['enq']} fre={p['fre']} alc={p['alloc']} psh={p['push']} "
              f"max={p['max_count']}/64 ratio={p['rolling_ratio']} stallSecs={p['secs_since_free']} "
              f"threads={p['threads']} callers={p['n_callers']} "
              f"crossed={p['thresholds_crossed']}")


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--spawn', action='store_true')
    parser.add_argument('--exe',
        default=r"F:\SteamLibrary\steamapps\common\Deadly Premonition The Director's Cut\DP.exe")
    args = parser.parse_args()

    print("DP1 Audio Guard — Phase A v5 (corrected Push hook + in_use diff)")
    print("=" * 70)

    device = frida.get_local_device()

    if args.spawn:
        import os
        try:
            pid = device.spawn([args.exe], cwd=os.path.dirname(args.exe))
            session = frida.attach(pid)
        except Exception as e:
            print(f"[!] Spawn failed: {e}")
            sys.exit(1)
    else:
        try:
            procs = [p for p in device.enumerate_processes() if p.name.lower() == 'dp.exe']
            if not procs:
                print("[!] DP.exe not running.")
                sys.exit(1)
            print(f"[+] Attaching to PID {procs[0].pid}...")
            session = frida.attach(procs[0].pid)
        except Exception as e:
            print(f"[!] Attach failed: {e}")
            sys.exit(1)

    script = session.create_script(JS_PAYLOAD)
    script.on('message', on_message)
    script.load()
    if args.spawn:
        device.resume(pid)

    print(f"[+] Ctrl+C to detach.")
    print()

    def sig_handler(sig, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGINT, sig_handler)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[+] Detaching...")
        try: session.detach()
        except: pass


if __name__ == '__main__':
    main()
