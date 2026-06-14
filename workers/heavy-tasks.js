'use strict';
/**
 * heavy-tasks.js — generic worker_threads handler for CPU/IO work that
 * would otherwise block the Electron main process and freeze IPC + UI.
 *
 * Currently handles:
 *   - 'nan-guard:analyze' / 'apply' / 'revert' — PE pattern-scan + hex patch
 *     (sha256, large file read, hash compare). Wraps the existing
 *     workers/nan_guard.js module which is itself synchronous.
 *   - 'fs:describe-dir-size' — recursive directory walk that can hit
 *     10k+ files on systems with heavy NVIDIA/AMD shader caches.
 *
 * Protocol (parent → worker):
 *   { id: <number>, op: <string>, args: <object> }
 * Protocol (worker → parent):
 *   { id: <number>, ok: boolean, result?: any, error?: string }
 *
 * Errors are caught and serialized into { ok: false, error } so the
 * worker never dies on a single bad input.
 */

const { parentPort } = require('worker_threads');
const fs   = require('fs');
const path = require('path');

const nanGuard = require('./nan_guard.js');

async function describeDirSize(dir) {
  let totalSize = 0;
  let fileCount = 0;
  let newestMtime = null;
  async function walk(d) {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); }
      else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(p);
          totalSize += st.size;
          fileCount++;
          const iso = st.mtime.toISOString();
          if (!newestMtime || iso > newestMtime) newestMtime = iso;
        } catch {}
      }
    }
  }
  await walk(dir);
  return { totalSize, fileCount, newestMtime };
}

async function dispatch(op, args) {
  switch (op) {
    case 'nan-guard:analyze': return await nanGuard.analyze(args.exePath);
    case 'nan-guard:apply':   return await nanGuard.apply(args.exePath);
    case 'nan-guard:revert':  return await nanGuard.revert(args.exePath);
    case 'fs:describe-dir-size': return await describeDirSize(args.dir);
    default: throw new Error(`Unknown op: ${op}`);
  }
}

parentPort.on('message', async (msg) => {
  const { id, op, args } = msg || {};
  try {
    const result = await dispatch(op, args || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
});
