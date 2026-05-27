// ─────────────────────────────────────────────────────────────────────────────
// NaN Hang Guard — experimental DP.exe runtime fix
//
// Patches a single 2-byte spin-loop assert inside DP.exe's float helper at
// VA 0x00409EA6.  The original layout:
//
//     00409EA2  85 C0       test eax, eax
//     00409EA4  74 02       je 00409EA8        ; if zero → fldz path
//     00409EA6  EB FE       jmp $              ; spin forever  ← patch target
//     00409EA8  D9 EE       fldz               ; load 0.0
//
// Real-world Chapter 3 hang dumps show NaN (0xFFC00000) propagating into this
// function during loading/cutscene transitions, hanging the main thread here.
// The patch rewrites EB FE → 90 90 (two NOPs) so both branches fall through to
// fldz and the function returns 0.0f instead of hanging.
//
// Pattern-scanned, hash-verified, reversible via a sidecar JSON.  See
// docs/NAN_HANG_GUARD.md for full reverse-engineering writeup.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs     = require('fs');
const crypto = require('crypto');

const PATTERN          = Buffer.from([0x85, 0xC0, 0x74, 0x02, 0xEB, 0xFE, 0xD9, 0xEE]);
const PATCHED_PATTERN  = Buffer.from([0x85, 0xC0, 0x74, 0x02, 0x90, 0x90, 0xD9, 0xEE]);
const TARGET_IN_PATTERN = 4;               // EB FE position inside the 8-byte pattern
const ORIGINAL_BYTES   = Buffer.from([0xEB, 0xFE]);
const PATCH_BYTES      = Buffer.from([0x90, 0x90]);
const EXPECTED_VA      = 0x00409EA6;
const SIDECAR_SUFFIX   = '.nanguard.json';

// Known-good Steam build hash (the only version this patch was validated against).
// Not enforced — only reported in diagnostics so the user can spot version drift.
const KNOWN_GOOD_SHA256 = '4118eae94bc6f2f584d206a7dd813a3d8ae14f6348e89d5d951d8765a5d81fa6';

function parsePeTextSection(buf) {
  if (buf.length < 0x200) throw new Error('File too small for PE header');
  if (buf[0] !== 0x4D || buf[1] !== 0x5A) throw new Error('Not an MZ executable');
  const peOff = buf.readUInt32LE(0x3C);
  if (peOff < 0 || peOff + 24 > buf.length) throw new Error('Invalid e_lfanew');
  if (buf.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') throw new Error('Not a PE file');
  const machine = buf.readUInt16LE(peOff + 4);
  if (machine !== 0x014C) throw new Error(`Not x86 PE (machine=0x${machine.toString(16)})`);
  const numSections = buf.readUInt16LE(peOff + 6);
  const optSize     = buf.readUInt16LE(peOff + 20);
  const imageBase   = buf.readUInt32LE(peOff + 24 + 28);
  const sectionsOff = peOff + 24 + optSize;

  for (let i = 0; i < numSections; i++) {
    const sOff = sectionsOff + i * 40;
    const name = buf.toString('ascii', sOff, sOff + 8).replace(/\0+$/, '');
    if (name === '.text') {
      return {
        imageBase,
        virtualAddress: buf.readUInt32LE(sOff + 12),
        virtualSize:    buf.readUInt32LE(sOff + 8),
        rawDataPtr:     buf.readUInt32LE(sOff + 20),
        rawDataSize:    buf.readUInt32LE(sOff + 16),
      };
    }
  }
  throw new Error('.text section not found');
}

function findAll(buf, needle, start, end) {
  const positions = [];
  const last = Math.min(end, buf.length) - needle.length;
  for (let i = start; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) positions.push(i);
  }
  return positions;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Inspect DP.exe and report the patch status without modifying anything.
 *
 * Status values:
 *   no-exe        — file missing or unreadable
 *   not-pe        — not a valid x86 PE
 *   no-pattern    — neither original nor patched pattern found (unsupported build)
 *   ambiguous     — multiple matches (refuse to act)
 *   found         — exactly one original pattern, ready to patch
 *   applied       — already patched (one match of patched pattern)
 */
async function analyze(exePath) {
  let buf;
  try {
    buf = await fs.promises.readFile(exePath);
  } catch (e) {
    return { ok: false, status: 'no-exe', error: e.message };
  }

  let sec;
  try {
    sec = parsePeTextSection(buf);
  } catch (e) {
    return { ok: false, status: 'not-pe', error: e.message };
  }

  const textStart = sec.rawDataPtr;
  const textEnd   = sec.rawDataPtr + sec.rawDataSize;

  const original = findAll(buf, PATTERN,         textStart, textEnd);
  const patched  = findAll(buf, PATCHED_PATTERN, textStart, textEnd);

  const result = {
    ok: true,
    exePath,
    fileSize:   buf.length,
    sha256:     sha256(buf),
    knownGood:  false,
    imageBase:  sec.imageBase,
    textVa:     sec.virtualAddress,
    textRawPtr: sec.rawDataPtr,
    originalMatches: original.length,
    patchedMatches:  patched.length,
  };
  result.knownGood = result.sha256 === KNOWN_GOOD_SHA256;

  if (patched.length === 1 && original.length === 0) {
    const fileOffset = patched[0] + TARGET_IN_PATTERN;
    return {
      ...result,
      status: 'applied',
      fileOffset,
      va: sec.imageBase + sec.virtualAddress + (fileOffset - sec.rawDataPtr),
    };
  }
  if (original.length === 1 && patched.length === 0) {
    const fileOffset = original[0] + TARGET_IN_PATTERN;
    return {
      ...result,
      status: 'found',
      fileOffset,
      va: sec.imageBase + sec.virtualAddress + (fileOffset - sec.rawDataPtr),
    };
  }
  if (original.length === 0 && patched.length === 0) {
    return { ...result, status: 'no-pattern' };
  }
  return { ...result, status: 'ambiguous' };
}

/**
 * Apply the patch. Writes a sidecar JSON with revert metadata.
 * Idempotent: returns {alreadyApplied:true} if already patched.
 */
async function apply(exePath) {
  const info = await analyze(exePath);
  if (info.status === 'applied') {
    return { ok: true, alreadyApplied: true, info };
  }
  if (info.status !== 'found') {
    return { ok: false, status: info.status, info };
  }

  const fd = await fs.promises.open(exePath, 'r+');
  try {
    const verify = Buffer.alloc(2);
    await fd.read(verify, 0, 2, info.fileOffset);
    if (verify[0] !== ORIGINAL_BYTES[0] || verify[1] !== ORIGINAL_BYTES[1]) {
      return {
        ok: false,
        status: 'verify-failed',
        info,
        bytesRead: [verify[0], verify[1]],
      };
    }
    await fd.write(PATCH_BYTES, 0, 2, info.fileOffset);
    if (typeof fd.sync === 'function') {
      try { await fd.sync(); } catch { /* ignore */ }
    }
  } finally {
    await fd.close();
  }

  // Re-hash for the sidecar
  const postBuf = await fs.promises.readFile(exePath);
  const postHash = sha256(postBuf);

  const sidecar = {
    name:      'DP1 Launcher / Experimental NaN Hang Guard',
    version:   1,
    appliedAt: new Date().toISOString(),
    target: {
      fileOffset: info.fileOffset,
      va:         info.va,
      original:   'EB FE',
      patched:    '90 90',
    },
    sha256: {
      before: info.sha256,
      after:  postHash,
    },
    note: 'Reversible via DP1 Launcher → Settings → Stability → NaN Hang Guard → Revert',
  };
  await fs.promises.writeFile(exePath + SIDECAR_SUFFIX, JSON.stringify(sidecar, null, 2));

  return { ok: true, info: { ...info, status: 'applied', sha256After: postHash }, sidecar };
}

/**
 * Revert the patch. Reads sidecar for the file offset; falls back to pattern
 * scan if the sidecar is missing. Idempotent.
 */
async function revert(exePath) {
  const sidecarPath = exePath + SIDECAR_SUFFIX;
  let sidecar;
  try {
    sidecar = JSON.parse(await fs.promises.readFile(sidecarPath, 'utf8'));
  } catch { /* sidecar missing — pattern scan will handle it */ }

  const info = await analyze(exePath);

  if (info.status === 'found') {
    // Already reverted (or never patched) — clean up sidecar if any
    try { await fs.promises.unlink(sidecarPath); } catch {}
    return { ok: true, alreadyReverted: true, info };
  }
  if (info.status !== 'applied') {
    return { ok: false, status: info.status, info };
  }

  const fileOffset = sidecar?.target?.fileOffset ?? info.fileOffset;

  const fd = await fs.promises.open(exePath, 'r+');
  try {
    const verify = Buffer.alloc(2);
    await fd.read(verify, 0, 2, fileOffset);
    if (verify[0] !== PATCH_BYTES[0] || verify[1] !== PATCH_BYTES[1]) {
      return {
        ok: false,
        status: 'verify-failed',
        info,
        bytesRead: [verify[0], verify[1]],
      };
    }
    await fd.write(ORIGINAL_BYTES, 0, 2, fileOffset);
    if (typeof fd.sync === 'function') {
      try { await fd.sync(); } catch { /* ignore */ }
    }
  } finally {
    await fd.close();
  }

  try { await fs.promises.unlink(sidecarPath); } catch {}
  return { ok: true, info: { ...info, status: 'found' } };
}

module.exports = {
  analyze,
  apply,
  revert,
  PATTERN,
  PATCHED_PATTERN,
  ORIGINAL_BYTES,
  PATCH_BYTES,
  EXPECTED_VA,
  SIDECAR_SUFFIX,
  KNOWN_GOOD_SHA256,
};
