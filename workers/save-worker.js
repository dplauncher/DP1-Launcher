'use strict';
/**
 * save-worker.js — Worker thread for automatic save-game backup.
 *
 * Monitors {gameDir}/savedata/dp.sav every INTERVAL ms.
 * When the file changes (compared by content hash), it:
 *   1. Copies dp.sav → backups/{timestamp}/dp.sav
 *   2. Updates the reference hash
 *   3. Posts a 'backup-created' message to the main thread
 *
 * Messages IN:
 *   { type: 'start', gameDir: string, interval?: number }
 *   { type: 'stop' }
 *
 * Messages OUT:
 *   { type: 'backup-created', backupPath: string, timestamp: string }
 *   { type: 'error', error: string }
 *   { type: 'stopped' }
 *   { type: 'started', savePath: string }
 *   { type: 'no-save', savePath: string }
 */

const { parentPort } = require('worker_threads');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

let timer       = null;
let lastHash    = null;
let savePath    = null;
let backupsDir  = null;
let intervalMs  = 120_000; // 2 minutes default

function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex');
}

function formatTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function checkAndBackup() {
  try {
    if (!fs.existsSync(savePath)) return;

    const currentHash = hashFile(savePath);

    if (lastHash === null) {
      // First run — just record the hash, don't backup
      lastHash = currentHash;
      return;
    }

    if (currentHash === lastHash) return; // No changes

    // Save changed — create backup
    const timestamp = formatTimestamp();
    const destDir   = path.join(backupsDir, timestamp);
    fs.mkdirSync(destDir, { recursive: true });

    const destFile = path.join(destDir, 'dp.sav');
    fs.copyFileSync(savePath, destFile);

    lastHash = currentHash;

    parentPort.postMessage({
      type:       'backup-created',
      backupPath: destFile,
      timestamp,
    });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
}

function start(gameDir, interval) {
  stop(); // Clear any existing timer

  intervalMs = interval || 120_000;
  savePath   = path.join(gameDir, 'savedata', 'dp.sav');
  backupsDir = path.join(gameDir, 'savedata', 'backups');
  lastHash   = null;

  // Ensure backups directory exists
  fs.mkdirSync(backupsDir, { recursive: true });

  if (!fs.existsSync(savePath)) {
    parentPort.postMessage({ type: 'no-save', savePath });
    return;
  }

  // Initial snapshot — create one backup right away (deduped if an identical
  // copy already exists in backups/), so the user immediately sees a backup
  // entry instead of waiting up to `intervalMs` for the first change. Without
  // this, the worker silently records the hash and produces no visible
  // activity until the second save is detected — confusing UX.
  try {
    const initialHash = hashFile(savePath);

    let alreadyBackedUp = false;
    try {
      const dirs = fs.readdirSync(backupsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(backupsDir, d.name, 'dp.sav'))
        .filter(p => fs.existsSync(p));
      for (const p of dirs) {
        if (hashFile(p) === initialHash) { alreadyBackedUp = true; break; }
      }
    } catch {}

    if (!alreadyBackedUp) {
      const timestamp = formatTimestamp();
      const destDir   = path.join(backupsDir, timestamp);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(savePath, path.join(destDir, 'dp.sav'));
      parentPort.postMessage({
        type:       'backup-created',
        backupPath: path.join(destDir, 'dp.sav'),
        timestamp,
      });
    }
    lastHash = initialHash;
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: 'initial snapshot: ' + err.message });
    lastHash = hashFile(savePath); // fall back to just recording the hash
  }

  timer = setInterval(checkAndBackup, intervalMs);
  parentPort.postMessage({ type: 'started', savePath });
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastHash = null;
  parentPort.postMessage({ type: 'stopped' });
}

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'start': start(msg.gameDir, msg.interval); break;
    case 'stop':  stop(); break;
  }
});
