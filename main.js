'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const { Worker } = require('worker_threads');

// GitHub repo used for update checks + news feed
const UPDATE_REPO = 'dplauncher/DP1-Launcher';

// First-launch setup: external resources to download + extract.
//   archive: 'zip'    → PowerShell Expand-Archive
//            'targz'  → Windows built-in tar -xzf
//   target:  'gameDir'    → extracted into <gameDir>
//            'dxvkCache'  → extracted into <gameDir>/_dxvk-cache/  (kept out of game files)
const SETUP_COMPONENTS = [
  {
    id:       'dpfix',
    url:      'https://www.dropbox.com/scl/fi/i7c7tr1ndtpts2k05k1a9/dpfix095.zip?rlkey=dpiehe4gpgz06zrd7009ha7af&st=2p88cy5q&dl=1',
    fileName: 'dpfix095.zip',
    archive:  'zip',
    target:   'gameDir',
  },
  {
    id:       '4gb',
    url:      'https://ntcore.com/files/4gb_patch.zip',
    fileName: '4gb_patch.zip',
    archive:  'zip',
    target:   'gameDir',
  },
  {
    id:       'dxvk',
    url:      'https://github.com/doitsujin/dxvk/releases/download/v2.7.1/dxvk-2.7.1.tar.gz',
    fileName: 'dxvk-2.7.1.tar.gz',
    archive:  'targz',
    target:   'dxvkCache',
  },
];

// ─────────────────────────────────────────────
// Worker thread lifecycle
// ─────────────────────────────────────────────
let iniWorker      = null;
let saveWorker     = null;
let heavyWorker    = null;
let heavyTaskSeq   = 0;
const heavyPending = new Map();   // id → { resolve, reject }

function getHeavyWorker() {
  if (heavyWorker) return heavyWorker;
  heavyWorker = new Worker(path.join(__dirname, 'workers', 'heavy-tasks.js'));
  heavyWorker.on('message', (msg) => {
    const pending = heavyPending.get(msg.id);
    if (!pending) return;
    heavyPending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else        pending.reject(new Error(msg.error || 'worker error'));
  });
  heavyWorker.on('error', (err) => {
    console.error('[heavy-tasks] worker error:', err);
    // Fail all pending tasks; next call will respawn a fresh worker.
    for (const { reject } of heavyPending.values()) reject(err);
    heavyPending.clear();
    heavyWorker = null;
  });
  heavyWorker.on('exit', () => { heavyWorker = null; });
  return heavyWorker;
}

function runHeavyTask(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++heavyTaskSeq;
    heavyPending.set(id, { resolve, reject });
    getHeavyWorker().postMessage({ id, op, args });
  });
}

function getWorker() {
  if (iniWorker) return iniWorker;

  iniWorker = new Worker(path.join(__dirname, 'workers', 'ini-worker.js'));

  iniWorker.on('error', (err) => {
    console.error('[Worker] Error:', err);
    iniWorker = null;
  });

  iniWorker.on('exit', (code) => {
    if (code !== 0) console.error('[Worker] Exited with code', code);
    iniWorker = null;
  });

  return iniWorker;
}

/**
 * Send a message to the INI worker and await the matching reply.
 * Each message carries a unique id so concurrent calls are safe.
 */
function workerTask(payload) {
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    const id = `${Date.now()}-${Math.random()}`;

    const onMessage = (msg) => {
      if (msg.id !== id) return;
      worker.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
    };

    worker.on('message', onMessage);
    worker.postMessage({ ...payload, id });
  });
}

// ─────────────────────────────────────────────
// Backup helpers — every patch we apply (Skip Intro, DXVK hex-redirect, ...)
// keeps a copy of the original file in <gameDir>/exe_backup/ with a label
// that says what the backup represents, not what was overwritten. Examples:
//   DeadlyPremonition.exe_with_video  ← pre-Skip-Intro exe (intro still plays)
//   d3d9.dll_dpfix_only               ← DPfix d3d9 before DXVK hex-redirect
// Old <file>.bak files from earlier launcher versions are migrated on first
// touch so users don't end up with two separate backup conventions.
// ─────────────────────────────────────────────
const BACKUP_DIRNAME = 'exe_backup';

function getBackupDir(gameDir) {
  return path.join(gameDir, BACKUP_DIRNAME);
}
async function ensureBackupDir(gameDir) {
  const dir = getBackupDir(gameDir);
  try { await fs.promises.mkdir(dir, { recursive: true }); } catch {}
  return dir;
}
function backupPath(gameDir, label) {
  return path.join(getBackupDir(gameDir), label);
}
/**
 * Locate an existing backup for `originalPath`. Looks for the new
 * exe_backup/<label> location first; if absent, falls back to the legacy
 * <originalPath>.bak. If only the legacy file exists, it is moved into the
 * new location so subsequent calls find it in one place.
 *
 * Returns the resolved absolute path of the backup file, or null if none.
 */
async function resolveBackup(originalPath, label) {
  const gameDir = path.dirname(originalPath);
  const newPath = backupPath(gameDir, label);
  try { await fs.promises.access(newPath); return newPath; } catch {}
  const legacy = originalPath + '.bak';
  try {
    await fs.promises.access(legacy);
    await ensureBackupDir(gameDir);
    try { await fs.promises.rename(legacy, newPath); }
    catch { await fs.promises.copyFile(legacy, newPath); try { await fs.promises.unlink(legacy); } catch {} }
    return newPath;
  } catch {}
  return null;
}
/**
 * Create a backup of `originalPath` at exe_backup/<label> if one doesn't
 * already exist (in either the new or legacy location). Idempotent.
 */
async function makeBackup(originalPath, label) {
  const existing = await resolveBackup(originalPath, label);
  if (existing) return existing;
  const gameDir = path.dirname(originalPath);
  await ensureBackupDir(gameDir);
  const target = backupPath(gameDir, label);
  await fs.promises.copyFile(originalPath, target);
  return target;
}

const BACKUP_LABELS = {
  // <gameDir>/DeadlyPremonition.exe before the Skip Intro byte patch
  // (the byte at 0x243333 still reads B3 in this copy → intro videos play)
  exeWithVideo:  'DeadlyPremonition.exe_with_video',
  // <gameDir>/d3d9.dll as DPfix shipped it, before our DXVK hex-redirect
  // replaced its 'd3d9.dll' import string with 'd9vk.dll'
  d3d9DpfixOnly: 'd3d9.dll_dpfix_only',
};

/**
 * NTCore's `4gb_patch.exe` drops a `<exe>.Backup` next to whatever .exe
 * it patches (its own convention — capital B, no dot). To keep a single
 * backup folder, move that file into exe_backup/<basename>_pre_4gb after
 * every successful 4GB-patch run. Idempotent: if the target already
 * exists we just delete the stray `.Backup`.
 */
async function migrateNTCore4gbBackup(exePath) {
  if (!exePath) return null;
  const src = exePath + '.Backup';
  try { await fs.promises.access(src); } catch { return null; }   // nothing to migrate
  const gameDir = path.dirname(exePath);
  const dst     = backupPath(gameDir, `${path.basename(exePath)}_pre_4gb`);
  await ensureBackupDir(gameDir);
  try {
    await fs.promises.access(dst);
    // Already migrated — drop the stray NTCore copy.
    try { await fs.promises.unlink(src); } catch {}
    return dst;
  } catch { /* no existing backup, proceed */ }
  try { await fs.promises.rename(src, dst); }
  catch {
    await fs.promises.copyFile(src, dst);
    try { await fs.promises.unlink(src); } catch {}
  }
  return dst;
}

// ─────────────────────────────────────────────
// Settings persistence (userData JSON)
// All async — never blocks the IPC event loop.
// ─────────────────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'launcher-settings.json');
}

async function readSettings() {
  try {
    const raw = await fs.promises.readFile(getSettingsPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Serialize writes via a single-slot tail promise. Two rapid `settings-write`
// IPC calls used to race: both read, both write, second one wins and the first
// patch was lost. Now every write waits for the previous to finish so the
// patches stack predictably in call order.
let settingsWriteTail = Promise.resolve();
async function writeSettings(data) {
  const run = async () => {
    try {
      await fs.promises.writeFile(
        getSettingsPath(),
        JSON.stringify(data, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('[Settings] Write error:', err);
    }
  };
  const next = settingsWriteTail.then(run, run);   // never let a previous failure block the chain
  settingsWriteTail = next;
  return next;
}

// ─────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────
let mainWindow;
let splashWindow;
let tray = null;
let isQuitting = false;     // true once the user explicitly chose Quit
let trayLang   = 'uk';      // updated from renderer; controls tray menu labels

// Splash always stays visible for at least this long so the fill
// animation has time to complete.
const SPLASH_MIN_MS = 3000;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width:           480,
    height:          640,
    frame:           false,
    transparent:     true,
    resizable:       false,
    movable:         true,
    alwaysOnTop:     true,
    skipTaskbar:     false,
    show:            false,
    icon:            path.join(__dirname, 'assets', 'DP_LOGO.ico'),
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  // Pick splash language synchronously so the title text is correct from
  // the very first paint (avoid a UA→EN flip).
  let lang = 'en';
  try {
    const raw = require('fs').readFileSync(getSettingsPath(), 'utf-8');
    const s = JSON.parse(raw);
    if (s.language === 'uk' || s.language === 'en') lang = s.language;
  } catch {
    try { if ((app.getLocale() || '').startsWith('uk')) lang = 'uk'; } catch {}
  }
  splashWindow.loadFile(path.join(__dirname, 'src', 'splash.html'),
                         { query: { lang } });
  splashWindow.once('ready-to-show', () => splashWindow.show());
  splashWindow.on('closed', () => { splashWindow = null; });
}

function createWindow() {
  const winOptions = {
    width:       1440,
    height:      900,
    minWidth:    1180,
    minHeight:   780,
    resizable:   true,
    maximizable: true,
    frame:       false,
    show:        false,         // stays hidden until splash finishes
    icon:        path.join(__dirname, 'assets', 'DP_LOGO.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  };

  // Windows 11: native Acrylic/Mica blur
  if (process.platform === 'win32') {
    winOptions.backgroundColor        = '#101012';
    winOptions.backgroundMaterial     = 'acrylic'; // requires Electron ≥ 23 + Win 11
    winOptions.titleBarStyle          = 'hidden';
  } else {
    winOptions.vibrancy               = 'dark'; // macOS
    winOptions.backgroundColor        = '#101012';
  }

  mainWindow = new BrowserWindow(winOptions);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // DevTools is fully disabled for distribution.
}

/**
 * Reveal the main window only after BOTH:
 *   (1) the renderer reports `ready-to-show`, and
 *   (2) the minimum splash time has elapsed.
 * This guarantees the fill animation completes and the user never
 * sees a flash of empty main window.
 */
function setupSplashFlow() {
  let rendererReady = false;
  let minTimePassed = false;

  const reveal = () => {
    if (!rendererReady || !minTimePassed) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  };

  mainWindow.once('ready-to-show', () => { rendererReady = true; reveal(); });
  setTimeout(() => { minTimePassed = true; reveal(); }, SPLASH_MIN_MS);
}

// Windows: bind the taskbar icon/group to our AUMID so the taskbar shows
// our DP_LOGO instead of Electron's default — required in dev mode where
// the .exe icon comes from electron.exe, not our packaged build.
if (process.platform === 'win32') {
  try { app.setAppUserModelId('ua.littlebit.dp1-launcher'); } catch {}
}

app.whenReady().then(() => {
  createSplashWindow();
  createWindow();
  setupSplashFlow();
  // Pre-warm the worker thread so first INI load is instant
  getWorker();
});

app.on('window-all-closed', () => {
  if (iniWorker)        { iniWorker.terminate();        iniWorker        = null; }
  if (saveWorker)       { saveWorker.terminate();       saveWorker       = null; }
  if (heavyWorker)      { heavyWorker.terminate();      heavyWorker      = null; }
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null; }
  if (tray)             { tray.destroy();               tray             = null; }
  app.quit();
});

// ─────────────────────────────────────────────
// IPC – Window controls
// ─────────────────────────────────────────────
ipcMain.handle('window-minimize',  () => mainWindow?.minimize());
ipcMain.handle('window-maximize',  () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else                          mainWindow.maximize();
});
ipcMain.handle('window-close',     () => mainWindow?.close());
ipcMain.handle('quit-app',         () => { isQuitting = true; app.quit(); });

// ─────────────────────────────────────────────
// Tray — keep the launcher running while the game is open so the
// save-worker can keep snapshotting dp.sav every 2 minutes.
// ─────────────────────────────────────────────
const TRAY_LABELS = {
  uk: { show: 'Показати лаунчер', quit: 'Вийти з лаунчера', tip: 'DP1 Launcher — резервне копіювання активне' },
  en: { show: 'Show launcher',    quit: 'Quit launcher',    tip: 'DP1 Launcher — autosave backup running' },
};

function buildTrayMenu() {
  const L = TRAY_LABELS[trayLang] || TRAY_LABELS.en;
  return Menu.buildFromTemplate([
    { label: L.show, click: () => showMainWindow() },
    { type: 'separator' },
    { label: L.quit, click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray() {
  if (tray) return tray;
  const iconPath = path.join(__dirname, 'assets', 'DP_LOGO.ico');
  const img      = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip((TRAY_LABELS[trayLang] || TRAY_LABELS.en).tip);
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => showMainWindow());
  tray.on('click',        () => showMainWindow());
  return tray;
}

ipcMain.handle('hide-to-tray', (_event, lang) => {
  if (lang === 'uk' || lang === 'en') {
    trayLang = lang;
  }
  ensureTray();
  if (tray) {
    tray.setToolTip((TRAY_LABELS[trayLang] || TRAY_LABELS.en).tip);
    tray.setContextMenu(buildTrayMenu());
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
});

// ─────────────────────────────────────────────
// IPC – INI operations  (delegated to Worker)
// ─────────────────────────────────────────────
ipcMain.handle('load-ini', async (_event, filePath) => {
  return workerTask({ type: 'load', path: filePath });
});

ipcMain.handle('save-ini', async (_event, { filePath, lines, values }) => {
  return workerTask({ type: 'save', path: filePath, lines, values });
});

// ─────────────────────────────────────────────
// IPC – INI auto-detection  (ONLY next to game exe)
// fs.promises.access — non-blocking via libuv thread pool
// ─────────────────────────────────────────────
ipcMain.handle('find-ini', async () => {
  const settings = await readSettings();

  // No game path saved yet → renderer must prompt setup first
  if (!settings.gamePath) {
    return { found: false, needsSetup: true };
  }

  const gameDir   = path.dirname(settings.gamePath);
  const candidate = path.join(gameDir, 'DPfix.ini');

  try {
    await fs.promises.access(candidate, fs.constants.R_OK | fs.constants.W_OK);
    return { found: true, path: candidate };
  } catch {
    return { found: false, needsSetup: false };
  }
});

// ─────────────────────────────────────────────
// IPC – Dialogs
// ─────────────────────────────────────────────
ipcMain.handle('browse-ini', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Знайти DPfix.ini',
    filters:    [{ name: 'INI Files', extensions: ['ini'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('browse-exe', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Знайти виконуваний файл гри',
    filters:    [{ name: 'Executable', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

// ─────────────────────────────────────────────
// IPC – Game launch
//
// shell.openPath() wraps Windows ShellExecute — it correctly handles UAC
// elevation prompts and file permissions on protected executables.
// Previously used spawn() which threw an uncaught EACCES exception because
// the child 'error' event fired after the handler had already returned.
// ─────────────────────────────────────────────
ipcMain.handle('launch-game', async (_event, exePath) => {
  const errMsg = await shell.openPath(exePath);
  if (errMsg) return { success: false, error: errMsg };
  return { success: true };
});

// ─────────────────────────────────────────────
// IPC – Settings persistence
// Both handlers are async — fs.promises used internally.
// ─────────────────────────────────────────────
ipcMain.handle('settings-read',  async () => readSettings());
ipcMain.handle('settings-write', async (_event, data) => { await writeSettings(data); return true; });

// Full-reset: wipe persisted settings + activity log so the next launch
// shows the first-run wizard. Used when the user reinstalls the game and
// wants to re-run setup against the new install folder.
ipcMain.handle('settings-reset-all', async () => {
  const tryUnlink = async (p) => {
    try { await fs.promises.unlink(p); } catch { /* missing is fine */ }
  };
  await Promise.all([
    tryUnlink(getSettingsPath()),
    tryUnlink(getActivityPath()),
  ]);
  return true;
});

ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  isQuitting = true;
  app.exit(0);
});

// ─────────────────────────────────────────────
// IPC – System locale (instant sync getter — no I/O)
// ─────────────────────────────────────────────
ipcMain.handle('get-locale', () => app.getLocale());

// ─────────────────────────────────────────────
// IPC – Translations  (load /loc/*.json from disk)
//
// Renderer calls this once at startup; both languages are returned
// together so language switching stays synchronous afterwards.
// ─────────────────────────────────────────────
const LOC_DIR = path.join(__dirname, 'loc');

ipcMain.handle('get-translations', async () => {
  const read = async (file) => {
    const raw = await fs.promises.readFile(path.join(LOC_DIR, file), 'utf-8');
    return JSON.parse(raw);
  };
  const [uk, en] = await Promise.all([read('ukr.json'), read('eng.json')]);
  return { uk, en };
});

// ─────────────────────────────────────────────
// IPC – Open external links
//
// Whitelist-by-host so the renderer can't get the main process to open
// arbitrary URLs. The known team destinations (Telegram, Discord, X,
// YouTube) and any GitHub URL pointing at the update repo are allowed.
// ─────────────────────────────────────────────
const ALLOWED_HOSTS = new Set([
  't.me',
  'discord.gg', 'discord.com',
  'x.com', 'twitter.com',
  'youtube.com', 'www.youtube.com', 'youtu.be',
]);

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url !== 'string') return;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return;
    if (ALLOWED_HOSTS.has(u.hostname)) {
      shell.openExternal(url);
      return;
    }
    if (u.hostname === 'github.com' &&
        u.pathname.toLowerCase().startsWith('/' + UPDATE_REPO.toLowerCase())) {
      shell.openExternal(url);
    }
  } catch { /* invalid URL — ignore */ }
});

// ─────────────────────────────────────────────
// IPC – App version
// ─────────────────────────────────────────────
ipcMain.handle('get-version', () => app.getVersion());

// ─────────────────────────────────────────────
// IPC – Activity log (persisted in userData/activity.json)
// Capped at 200 most recent entries.
// ─────────────────────────────────────────────
function getActivityPath() {
  return path.join(app.getPath('userData'), 'activity.json');
}

async function readActivity() {
  try {
    const raw = await fs.promises.readFile(getActivityPath(), 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

async function writeActivity(arr) {
  try {
    await fs.promises.writeFile(getActivityPath(), JSON.stringify(arr, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Activity] Write error:', err);
  }
}

ipcMain.handle('activity-read', readActivity);

ipcMain.handle('activity-log', async (_event, entry) => {
  if (!entry || typeof entry !== 'object') return;
  const list = await readActivity();
  list.unshift({
    kind: String(entry.kind || 'info'),
    text: String(entry.text || ''),
    date: new Date().toISOString(),
  });
  // keep most recent 200
  if (list.length > 200) list.length = 200;
  await writeActivity(list);
  return true;
});

ipcMain.handle('activity-clear', async () => {
  await writeActivity([]);
  return true;
});

// ─────────────────────────────────────────────
// IPC – Fetch news feed from GitHub raw
//
// Reads:  https://raw.githubusercontent.com/<repo>/main/news.json
// Format: [ { "title": "...", "excerpt": "...", "date": "May 10, 2025" }, ... ]
//
// Network failures resolve to an empty list (renderer falls back to
// bundled mock data) so the launcher stays usable offline.
// ─────────────────────────────────────────────
ipcMain.handle('fetch-news', () => {
  return new Promise((resolve) => {
    const url = `https://raw.githubusercontent.com/${UPDATE_REPO}/main/news.json`;
    const req = https.get(url, {
      headers: { 'User-Agent': `DP1-Launcher/${app.getVersion()}`, 'Accept': 'application/json' },
      timeout: 6000,
    }, (res) => {
      // Follow up to 3 redirects (GitHub may move)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        https.get(res.headers.location, {
          headers: { 'User-Agent': `DP1-Launcher/${app.getVersion()}` },
          timeout: 6000,
        }, (r2) => handle(r2)).on('error', (err) => resolve({ items: [], error: err.message }));
        return;
      }
      handle(res);
    });
    req.on('error',   (err) => resolve({ items: [], error: err.message }));
    req.on('timeout', ()    => req.destroy(new Error('timeout')));

    function handle(res) {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ items: [], error: `HTTP ${res.statusCode}` });
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const items = Array.isArray(data) ? data : (data.items || []);
          resolve({ items });
        } catch (err) {
          resolve({ items: [], error: err.message });
        }
      });
    }
  });
});

// ─────────────────────────────────────────────
// IPC – Launch game via Steam (steam://run/<appId>)
//
// Numeric app-id only — validated server-side to keep URL construction safe.
// ─────────────────────────────────────────────
ipcMain.handle('launch-steam', (_event, appId) => {
  const id = String(appId ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) return { success: false, error: 'invalid app id' };
  shell.openExternal(`steam://run/${id}`);
  return { success: true };
});

// steam://validate/<appid> tells Steam client to re-verify local file
// integrity and re-download anything missing or corrupted. This is the
// canonical "restore game to vanilla" path — Steam overwrites every file
// the launcher (or DPfix/DXVK/4GB patch/etc.) modified. Note: it does NOT
// touch our own exe_backup/ folder, so existing backups are preserved.
ipcMain.handle('steam-validate', (_event, appId) => {
  const id = String(appId ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) return { success: false, error: 'invalid app id' };
  shell.openExternal(`steam://validate/${id}`);
  return { success: true };
});

// ─────────────────────────────────────────────
// IPC – Update check (GitHub releases)
//
// Fetches the latest non-draft, non-prerelease release from GitHub and
// returns { hasUpdate, currentVersion, latestVersion, name, body, htmlUrl }.
// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers (used across IPC handlers)
// Note: the canonical `is-admin` and `relaunch-as-admin` IPC handlers live
// at ~line 2084 (async exec-based, doesn't block the event loop). `isAdmin()`
// here is the same logic exposed for direct use from other handlers, such as
// `apply-preset`'s DPfix+DXVK pre-flight check.
// ─────────────────────────────────────────────────────────────────────────────
async function exists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

async function isAdmin() {
  return await new Promise((resolve) => {
    require('child_process').exec(
      'net session',
      { windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure HTTPS GET — no extra dependencies. Network failures resolve to
// { hasUpdate: false, error } so the renderer can stay silent.
// ─────────────────────────────────────────────
function compareSemver(a, b) {
  const parse = (s) => String(s).replace(/^v/i, '').split(/[.\-+]/).map(p => {
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? 0 : n;
  });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

ipcMain.handle('check-update', () => {
  return new Promise((resolve) => {
    const currentVersion = app.getVersion();

    const req = https.request({
      hostname: 'api.github.com',
      path:     `/repos/${UPDATE_REPO}/releases/latest`,
      method:   'GET',
      headers: {
        'User-Agent': `DP1-Launcher/${currentVersion}`,
        'Accept':     'application/vnd.github+json',
      },
      timeout: 6000,
    }, (res) => {
      // Follow a single redirect if GitHub returns one
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        res.resume();
        return resolve({ hasUpdate: false, error: 'redirect' });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ hasUpdate: false, error: `HTTP ${res.statusCode}` });
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.draft || data.prerelease || !data.tag_name) {
            return resolve({ hasUpdate: false, currentVersion });
          }
          const latestVersion = String(data.tag_name).replace(/^v/i, '');
          const hasUpdate = compareSemver(currentVersion, latestVersion) < 0;
          resolve({
            hasUpdate,
            currentVersion,
            latestVersion,
            name:    data.name    || data.tag_name,
            body:    data.body    || '',
            htmlUrl: data.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`,
            publishedAt: data.published_at || null,
          });
        } catch (err) {
          resolve({ hasUpdate: false, error: err.message });
        }
      });
    });

    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error',   (err) => resolve({ hasUpdate: false, currentVersion, error: err.message }));
    req.end();
  });
});

// ─────────────────────────────────────────────
// IPC – Auto-update flow
//
// Finds the newest release asset (.zip) for the configured repo, downloads
// it to %TEMP%, extracts to %TEMP%\dp1-update-<ts>\, then writes a small
// batch file that waits for this app to exit, robocopies the new files
// over the current install, restarts the new .exe, and self-deletes.
// Progress events stream to the renderer via 'update-progress'.
// ─────────────────────────────────────────────
async function findLatestZipAssetUrl() {
  return new Promise((resolve, reject) => {
    https.request({
      hostname: 'api.github.com',
      path:     `/repos/${UPDATE_REPO}/releases/latest`,
      method:   'GET',
      headers:  {
        'User-Agent': `DP1-Launcher/${app.getVersion()}`,
        'Accept':     'application/vnd.github+json',
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const asset = (data.assets || []).find(a => /\.zip$/i.test(a.name));
          if (!asset) return reject(new Error('No ZIP asset on latest release'));
          resolve({ url: asset.browser_download_url, name: asset.name, size: asset.size });
        } catch (err) { reject(err); }
      });
    }).on('error', reject).end();
  });
}

ipcMain.handle('apply-update', async () => {
  const send = (type, extra = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-progress', { type, ...extra });
    }
  };
  // Refuse to auto-update when running from a dev checkout. process.execPath
  // points at node_modules/electron/dist/electron.exe in that case, and the
  // update would robocopy the launcher binary OVER Electron itself, wrecking
  // the dev environment until you delete the polluted files by hand.
  if (!app.isPackaged) {
    send('error', { error: 'Auto-update is disabled in dev mode (running un-packaged Electron).' });
    return { success: false, error: 'dev-mode' };
  }
  try {
    send('locating');
    const asset = await findLatestZipAssetUrl();

    // v1.5.2: stage download + extraction NEXT TO the running .exe instead of
    // %TEMP%. Same-drive robocopy is faster, the staging folder is visible
    // alongside the launcher (so users can see what's happening), and we don't
    // depend on %TEMP% surviving Disk Cleanup or being on the same partition.
    const installDir = path.dirname(process.execPath);
    const stamp = Date.now();
    const stagingDir = path.join(installDir, `.update-${stamp}`);
    const stagingZip = path.join(installDir, `.update-${stamp}.zip`);

    try {
      await fs.promises.mkdir(stagingDir, { recursive: true });
    } catch (e) {
      // Install dir not writable (e.g., Program Files without admin) — fall
      // back to %TEMP% so the update still works. User-warn via 'staging-fallback'.
      send('staging-fallback', { reason: e.message, fallback: os.tmpdir() });
    }
    const stagingWritable = await exists(stagingDir);
    const zipPath    = stagingWritable ? stagingZip : path.join(os.tmpdir(), `dp1-update-${stamp}.zip`);
    const extractDir = stagingWritable ? stagingDir : path.join(os.tmpdir(), `dp1-update-${stamp}-x`);

    send('downloading', { name: asset.name, downloaded: 0, total: asset.size, speed: 0, stagingDir: extractDir });
    await downloadToFile(asset.url, zipPath, (p) => send('downloading', { ...p, name: asset.name }));

    send('extracting');
    await extractZip(zipPath, extractDir);

    // Build a batch script that swaps files + restarts the app
    const installDirEscaped = installDir.replace(/\\/g, '\\');
    const exeName    = path.basename(process.execPath);
    const batchPath = path.join(os.tmpdir(), `dp1-update-${stamp}.bat`);
    const vbsPath   = path.join(os.tmpdir(), `dp1-update-${stamp}.vbs`);
    // Exclude the staging folder + its sibling zip from robocopy so it doesn't
    // try to copy the extraction over itself.
    const stagingBaseName = path.basename(extractDir);
    const zipBaseName     = path.basename(zipPath);
    const xdSwitches = (extractDir.startsWith(installDir + path.sep) || extractDir === installDir)
      ? `/XD "${path.join(installDir, stagingBaseName).replace(/\\/g, '\\')}" /XF "${path.join(installDir, zipBaseName).replace(/\\/g, '\\')}"`
      : '';
    const batch =
      '@echo off\r\n' +
      'chcp 65001 >nul\r\n' +
      'timeout /t 2 /nobreak >nul\r\n' +
      // Try up to 10 times in case the .exe is still locked
      `:retry\r\n` +
      `robocopy "${extractDir.replace(/\\/g, '\\')}" "${installDirEscaped}" /E ${xdSwitches} /R:5 /W:2 /NFL /NDL /NJH /NJS >nul\r\n` +
      `if errorlevel 8 (timeout /t 1 /nobreak >nul & goto retry)\r\n` +
      `start "" "${path.join(installDir, exeName).replace(/\\/g, '\\')}"\r\n` +
      `rmdir /s /q "${extractDir.replace(/\\/g, '\\')}" >nul 2>&1\r\n` +
      `del "${zipPath.replace(/\\/g, '\\')}" >nul 2>&1\r\n` +
      `del "${vbsPath.replace(/\\/g, '\\')}" >nul 2>&1\r\n` +
      `del "%~f0"\r\n`;
    await fs.promises.writeFile(batchPath, batch, { encoding: 'utf8' });

    // VBS wrapper to launch the batch with a truly hidden window.
    // Node's windowsHide flag is ignored when detached:true is set (DETACHED_PROCESS
    // overrides CREATE_NO_WINDOW), so the cmd console flashes onscreen. WScript.Shell.Run
    // uses ShellExecute under the hood — windowStyle=0 hides the child reliably.
    const vbs = `CreateObject("WScript.Shell").Run "cmd /c ""${batchPath}""", 0, False\r\n`;
    await fs.promises.writeFile(vbsPath, vbs, { encoding: 'utf8' });

    send('installing');

    const { spawn } = require('child_process');
    spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio:    'ignore',
      windowsHide: true,
      shell:    false,
    }).unref();

    // Give the batch ~1.5s head start, then quit so it can replace files
    setTimeout(() => app.quit(), 1500);
    return { success: true };
  } catch (err) {
    console.error('[update] failed:', err);
    send('error', { error: err.message });
    return { success: false, error: err.message };
  }
});

// ─────────────────────────────────────────────
// IPC – First-launch setup wizard
//
// 1) pick-game-dir       — open folder dialog, validate DeadlyPremonition.exe
// 2) setup-install-all   — download + unzip each SETUP_COMPONENTS entry into
//                          the chosen game directory, streaming per-component
//                          progress events to the renderer via 'setup-progress'.
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// IPC – Autodetect game install
//
// Scans known Steam install paths + every library listed in
// `steamapps/libraryfolders.vdf` for the game folder. Returns the
// first match or null.
// ─────────────────────────────────────────────
const GAME_FOLDER_NAME = "Deadly Premonition The Director's Cut";
// The game ships as either DP.exe or DeadlyPremonition.exe depending on
// install/version. Both are accepted as the main executable.
const GAME_EXE_NAMES   = ['DP.exe', 'DeadlyPremonition.exe'];

async function findGameExeInDir(dir) {
  for (const name of GAME_EXE_NAMES) {
    const exe = path.join(dir, name);
    try {
      await fs.promises.access(exe, fs.constants.R_OK);
      return exe;
    } catch { /* try next */ }
  }
  return null;
}

ipcMain.handle('autodetect-game', async () => {
  const candidate = async (dir) => {
    const exe = await findGameExeInDir(dir);
    return exe ? { dir, exePath: exe } : null;
  };

  // 1) Likely Steam root locations
  const steamRoots = new Set();
  const tryAdd = (p) => { if (p) steamRoots.add(p.replace(/[\\/]+$/, '')); };
  tryAdd(process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'));
  tryAdd(process.env['ProgramFiles']      && path.join(process.env['ProgramFiles'],      'Steam'));
  tryAdd('C:\\Program Files (x86)\\Steam');
  tryAdd('C:\\Program Files\\Steam');

  // 2) Registry lookup — Steam stores its install path here
  if (process.platform === 'win32') {
    try {
      const out = await psExec(
        "$p = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -Name 'InstallPath' -ErrorAction SilentlyContinue).InstallPath; " +
        "if (-not $p) { $p = (Get-ItemProperty -Path 'HKCU:\\SOFTWARE\\Valve\\Steam' -Name 'SteamPath' -ErrorAction SilentlyContinue).SteamPath }; " +
        "if ($p) { Write-Output $p }"
      );
      if (out) tryAdd(out.trim().replace(/\//g, '\\'));
    } catch { /* registry unavailable — skip */ }
  }

  // 3) For every Steam root, parse libraryfolders.vdf to discover other libraries
  const libraries = new Set();
  for (const root of steamRoots) {
    libraries.add(root);
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    try {
      const raw = await fs.promises.readFile(vdf, 'utf-8');
      // matches both old and new VDF formats: "path"   "X:\\\\Foo"
      const re = /"path"\s+"([^"]+)"/gi;
      let m;
      while ((m = re.exec(raw)) !== null) {
        libraries.add(m[1].replace(/\\\\/g, '\\').replace(/[\\/]+$/, ''));
      }
    } catch { /* no vdf in this root — skip */ }
  }

  // 4) Check each library
  for (const lib of libraries) {
    const dir = path.join(lib, 'steamapps', 'common', GAME_FOLDER_NAME);
    const hit = await candidate(dir);
    if (hit) return hit;
  }

  return null;
});

ipcMain.handle('pick-game-dir', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Виберіть папку гри (Deadly Premonition: Director\'s Cut)',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return null;

  const dir     = filePaths[0];
  const exePath = await findGameExeInDir(dir);
  return exePath
    ? { dir, exePath, valid: true }
    : { dir, exePath: null, valid: false };
});

/**
 * HTTPS GET → write stream, with redirect support and a progress callback.
 * Callback receives { downloaded, total, speed } where speed is bytes/sec.
 */
function downloadToFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let downloaded = 0;
    let total      = 0;
    const start    = Date.now();
    const file     = fs.createWriteStream(destPath);

    const cleanup = (err) => {
      try { file.close(); } catch {}
      fs.promises.unlink(destPath).catch(() => {});
      reject(err);
    };

    const go = (currentUrl, redirectsLeft) => {
      let parsed;
      try { parsed = new URL(currentUrl); }
      catch (e) { return cleanup(e); }

      const req = https.get(parsed, {
        headers: { 'User-Agent': `DP1-Launcher/${app.getVersion()}` },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return cleanup(new Error('Too many redirects'));
          return go(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return cleanup(new Error(`HTTP ${res.statusCode}`));
        }

        total = parseInt(res.headers['content-length'] || '0', 10) || 0;

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress) {
            const elapsed = (Date.now() - start) / 1000;
            const speed   = elapsed > 0 ? downloaded / elapsed : 0;
            onProgress({ downloaded, total, speed });
          }
        });

        res.pipe(file);
        file.on('finish', () => { file.close(() => resolve({ size: downloaded })); });
        file.on('error',  cleanup);
      });

      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      req.on('error',   cleanup);
    };

    go(url, 5);
  });
}

/** Extract a ZIP into a destination folder via PowerShell Expand-Archive. */
async function extractZip(zipPath, destDir) {
  const zp = psEscPath(zipPath);
  const dp = psEscPath(destDir);
  await psExec(
    `Expand-Archive -LiteralPath "${zp}" -DestinationPath "${dp}" -Force; Write-Output 'ok'`
  );
}

/**
 * Extract a .tar.gz via the Windows-built-in bsdtar.
 *
 * Use an absolute path to `System32\tar.exe` rather than `tar` from PATH,
 * because Git Bash / MSYS may inject a GNU tar that interprets `C:` as a
 * remote host (yielding "Cannot connect to C: resolve failed"). The
 * Win10+ bsdtar handles Windows paths natively without that quirk.
 */
function extractTarGz(tarPath, destDir) {
  const tarExe = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  return new Promise((resolve, reject) => {
    require('child_process').execFile(
      tarExe,
      ['-xzf', tarPath, '-C', destDir],
      { windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else     resolve();
      }
    );
  });
}

async function extractArchive(archivePath, destDir, kind) {
  await fs.promises.mkdir(destDir, { recursive: true });
  if (kind === 'targz') return extractTarGz(archivePath, destDir);
  return extractZip(archivePath, destDir);
}

/**
 * Heuristic detection of an already-installed component, so we don't
 * re-download what's already on disk. Checks for the most distinctive
 * file each component leaves behind.
 */
async function isComponentInstalled(comp, gameDir) {
  const exists = async (p) => { try { await fs.promises.access(p); return true; } catch { return false; } };
  switch (comp.id) {
    case 'dpfix':
      // DPfix drops d3d9.dll + DPfix.ini next to the game exe
      return (await exists(path.join(gameDir, 'd3d9.dll')))
          || (await exists(path.join(gameDir, 'DPfix.ini')));
    case '4gb':
      return exists(path.join(gameDir, '4gb_patch.exe'));
    case 'dxvk': {
      const cacheDir = path.join(gameDir, '_dxvk-cache');
      try {
        const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && /^dxvk-/i.test(e.name)) {
            if (await exists(path.join(cacheDir, e.name, 'x32', 'd3d9.dll'))) return true;
          }
        }
      } catch {}
      return false;
    }
    default:
      return false;
  }
}

ipcMain.handle('setup-install-all', async (_event, { gameDir }) => {
  const send = (id, type, extra = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('setup-progress', { id, type, ...extra });
    }
  };

  const results = {};
  const dxvkCacheDir = path.join(gameDir, '_dxvk-cache');

  for (const comp of SETUP_COMPONENTS) {
    // Skip if already installed — saves bandwidth + time on re-runs
    if (await isComponentInstalled(comp, gameDir)) {
      send(comp.id, 'skipped');
      results[comp.id] = { success: true, skipped: true };
      continue;
    }

    const tmpPath = path.join(os.tmpdir(), `dp1-${Date.now()}-${comp.fileName}`);
    const destDir =
      comp.target === 'dxvkCache' ? dxvkCacheDir : gameDir;

    try {
      send(comp.id, 'downloading', { downloaded: 0, total: 0, speed: 0 });

      await downloadToFile(comp.url, tmpPath, (p) => {
        send(comp.id, 'downloading', p);
      });

      send(comp.id, 'extracting');
      await extractArchive(tmpPath, destDir, comp.archive || 'zip');

      send(comp.id, 'done');
      results[comp.id] = { success: true };
    } catch (err) {
      console.error(`[setup] ${comp.id} failed:`, err);
      send(comp.id, 'error', { error: err.message });
      results[comp.id] = { success: false, error: err.message };
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  }

  return results;
});

// ─────────────────────────────────────────────
// IPC – Apply 4GB LAA patch automatically.
// Runs `4gb_patch.exe <targetExe>` — prefers the copy in gameDir
// (placed by first-run install) and falls back to the bundled copy.
// ─────────────────────────────────────────────
ipcMain.handle('apply-4gb-auto', async (_event, { gameDir, targetExe }) => {
  let patchExe = path.join(gameDir, '4gb_patch.exe');
  try { await fs.promises.access(patchExe); }
  catch { patchExe = path.join(process.resourcesPath, '4gb_patch.exe'); }

  return new Promise((resolve) => {
    const cmd = `"${patchExe}" "${targetExe}"`;
    require('child_process').exec(
      cmd,
      { cwd: path.dirname(patchExe), windowsHide: false },
      async (err) => {
        if (err) { resolve({ success: false, error: err.message }); return; }
        try { await migrateNTCore4gbBackup(targetExe); } catch {}
        resolve({ success: true });
      }
    );
  });
});

// ─────────────────────────────────────────────
// IPC – Apply DXVK automatically.
//
// Two-step process:
//   1) Copy <dxvk-cache>/dxvk-<ver>/x32/d3d9.dll  →  C:\Windows\SysWOW64\d9vk.dll
//      (renamed; requires admin since SysWOW64 is system-protected)
//   2) Hex-replace the ASCII string 'd3d9.dll' with 'd9vk.dll' inside the
//      DPfix-installed <gameDir>/d3d9.dll (preserves length — 8 chars each).
//      Creates a .bak before writing.
// ─────────────────────────────────────────────
const DXVK_SYS_TARGET = path.join('C:\\Windows\\SysWOW64', 'd9vk.dll');

// ─────────────────────────────────────────────
// IPC – Detect whether each post-install patch is already applied,
// so the Step 2 cards can show a "done" state instead of offering "Так".
//
// 4GB LAA check:
//   PE32 IMAGE_FILE_HEADER.Characteristics — bit 0x0020 means LAA.
//   PE header offset is at file offset 0x3C; Characteristics sits at
//   peOffset + 4 (signature) + 18 (offset inside COFF header).
//
// DXVK check:
//   System DLL exists at SysWOW64\d9vk.dll  AND  the game's d3d9.dll
//   contains the ASCII string "d9vk.dll" (which our hex patcher writes).
// ─────────────────────────────────────────────
async function isLargeAddressAware(exePath) {
  let fh;
  try {
    fh = await fs.promises.open(exePath, 'r');
    const peOffsetBuf = Buffer.alloc(4);
    await fh.read(peOffsetBuf, 0, 4, 0x3C);
    const peOffset = peOffsetBuf.readUInt32LE(0);
    const charBuf = Buffer.alloc(2);
    await fh.read(charBuf, 0, 2, peOffset + 4 + 18);
    return (charBuf.readUInt16LE(0) & 0x0020) !== 0;
  } catch {
    return false;
  } finally {
    try { await fh?.close(); } catch {}
  }
}

ipcMain.handle('check-4gb-applied', async (_event, { exePath }) => {
  if (!exePath) return { applied: false };
  return { applied: await isLargeAddressAware(exePath) };
});

// ─────────────────────────────────────────────
// IPC – Skip Intro Videos
//
// Community-known single-byte hex patch on the game executable:
//   offset 0x243333  B3 → 00   (skip intro), 00 → B3 (restore).
// We write a .bak alongside the .exe on first patch, validate the
// byte we expect to see before touching, and treat any other value
// as "exe doesn't match — refuse and report".
// ─────────────────────────────────────────────
const SKIP_INTRO_OFFSET   = 0x243333;
const SKIP_INTRO_ORIGINAL = 0xB3;
const SKIP_INTRO_PATCHED  = 0x00;

async function readSkipIntroByte(exePath) {
  let fh;
  try {
    fh = await fs.promises.open(exePath, 'r');
    const buf = Buffer.alloc(1);
    await fh.read(buf, 0, 1, SKIP_INTRO_OFFSET);
    return buf[0];
  } finally {
    try { await fh?.close(); } catch {}
  }
}

ipcMain.handle('check-skip-intro', async (_event, { exePath }) => {
  if (!exePath) return { supported: false, applied: false };
  try {
    const byte = await readSkipIntroByte(exePath);
    if (byte === SKIP_INTRO_PATCHED)  return { supported: true, applied: true };
    if (byte === SKIP_INTRO_ORIGINAL) return { supported: true, applied: false };
    return { supported: false, applied: false, byte };
  } catch (err) {
    return { supported: false, applied: false, error: err.message };
  }
});

ipcMain.handle('apply-skip-intro', async (_event, { exePath, enable }) => {
  if (!exePath) return { success: false, error: 'No exe path' };
  let fh;
  try {
    // First touch: keep a copy of the pre-patch exe (still plays intro)
    // in <gameDir>/exe_backup/DeadlyPremonition.exe_with_video.
    await makeBackup(exePath, BACKUP_LABELS.exeWithVideo);

    const current  = await readSkipIntroByte(exePath);
    const expected = enable ? SKIP_INTRO_ORIGINAL : SKIP_INTRO_PATCHED;
    const target   = enable ? SKIP_INTRO_PATCHED  : SKIP_INTRO_ORIGINAL;

    if (current === target) {
      return { success: true, alreadyApplied: true };
    }
    if (current !== expected) {
      return {
        success: false,
        error: `Unexpected byte 0x${current.toString(16).padStart(2, '0').toUpperCase()} at 0x${SKIP_INTRO_OFFSET.toString(16)}. Expected 0x${expected.toString(16).padStart(2,'0').toUpperCase()}. This .exe doesn't match the known DP:DC build.`,
      };
    }

    fh = await fs.promises.open(exePath, 'r+');
    await fh.write(Buffer.from([target]), 0, 1, SKIP_INTRO_OFFSET);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    try { await fh?.close(); } catch {}
  }
});

// ─────────────────────────────────────────────
// IPC – FPS Cap 60 (universal)
//
// The DP engine was designed for fixed 30/60 FPS. At higher framerates,
// its delta-time math (FUN_0041c270 / FUN_00700650 selector) breaks
// either timing accuracy (Path A: ceil drift) or physics smoothness
// (Path B: integer-step stutter). 60 FPS is the only mode where both
// paths produce identical, correct results.
//
// Implementation strategy (in order of effectiveness):
//
//   1. Primary: write `dxvk.maxFrameRate = 60` to <gameDir>/dxvk.conf
//      — DXVK is bundled by this launcher's first-run install, so this
//        works regardless of GPU vendor (NVIDIA/AMD/Intel).
//      — DXVK enforces the cap via Sleep() at present-time, independent
//        of VSync / monitor refresh.
//
//   2. Fallback: detect the user's GPU vendor (NVIDIA / AMD / Intel) and
//      offer a button that opens the vendor's control panel, with a
//      modal showing where to set the per-game cap manually.
//      — Some users disable DXVK, or DXVK config gets bypassed by VSync
//        on certain driver versions; the vendor cap is authoritative.
// ─────────────────────────────────────────────
const DXVK_CONF_FILENAME = 'dxvk.conf';
const FPS_CAP_KEY        = 'dxvk.maxFrameRate';
const FPS_CAP_VALUE      = '60';

// Vendor tools tried in order; first match wins. Mix of:
//   { exe: '<path>' }  — classic exe, launch via execFile
//   { uwp: '<pkgFamily!appId>' } — UWP app, launch via shell:appsFolder
const VENDOR_TOOLS = {
  nvidia: [
    // Legacy desktop NVCP — preferred when present (has the per-program
    // "Max Frame Rate" page; NVIDIA App opens GeForce-Experience-style
    // UI that doesn't expose this setting directly).
    { exe: 'C:\\Program Files\\NVIDIA Corporation\\Control Panel Client\\nvcplui.exe' },
    { exe: 'C:\\Program Files (x86)\\NVIDIA Corporation\\Control Panel Client\\nvcplui.exe' },
    // UWP NVIDIA Control Panel (Win 10+ Microsoft Store version) — also
    // has the Program Settings tab with Max Frame Rate.
    { uwp: 'NVIDIACorp.NVIDIAControlPanel_56jybvy8sckqj!NVIDIACorp.NVIDIAControlPanel' },
    // NVIDIA App / GeForce Experience — last resort, lacks the legacy
    // per-program FPS cap page.
    { exe: 'C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\CEF\\NVIDIA app.exe' },
    { exe: 'C:\\Program Files (x86)\\NVIDIA Corporation\\NVIDIA App\\CEF\\NVIDIA app.exe' },
  ],
  amd: [
    // Modern AMD Adrenalin (Radeon Software)
    { exe: 'C:\\Program Files\\AMD\\CNext\\CNext\\RadeonSoftware.exe' },
    { exe: 'C:\\Program Files\\AMD\\CNext\\CNext\\cnext.exe' },
    // UWP fallback if installed via Store
    { uwp: 'AdvancedMicroDevicesInc-2.AMDRadeonSoftware_0a9344xs7nr4m!App' },
  ],
  intel: [
    // Intel Graphics Command Center (UWP, primary)
    { uwp: 'AppUp.IntelGraphicsExperience_8j3eq9eme6ctt!App' },
    // Older Intel HD Graphics Control Panel (legacy)
    { exe: 'C:\\Windows\\System32\\IntelGraphicsExperience.exe' },
  ],
};

function parseDxvkConf(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

function stringifyDxvkConf(map) {
  if (!map.size) return '';
  const lines = [];
  for (const [k, v] of map) lines.push(`${k} = ${v}`);
  return lines.join('\n') + '\n';
}

async function readDxvkConf(gameDir) {
  const confPath = path.join(gameDir, DXVK_CONF_FILENAME);
  try {
    const content = await fs.promises.readFile(confPath, 'utf-8');
    return { confPath, map: parseDxvkConf(content) };
  } catch {
    return { confPath, map: new Map() };
  }
}

/** Detect installed GPU vendor via WMI; falls back to checking known DLLs. */
async function detectGpuVendor() {
  try {
    const out = await psExec(
      "Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | " +
      "ForEach-Object { $_.Name } | Out-String"
    );
    const lower = out.toLowerCase();
    if (lower.includes('nvidia') || lower.includes('geforce') || lower.includes('quadro')) return 'nvidia';
    if (lower.includes('amd')    || lower.includes('radeon')) return 'amd';
    if (lower.includes('intel')) return 'intel';
  } catch {}
  // Fallback: presence of vendor DLLs in System32
  const sys32 = 'C:\\Windows\\System32\\';
  for (const [vendor, dll] of [['nvidia','nvapi64.dll'],['amd','atiumdag.dll'],['intel','igd9d8umd32.dll']]) {
    try { await fs.promises.access(sys32 + dll); return vendor; } catch {}
  }
  return 'unknown';
}

/** Check if a UWP app is installed by package family name. */
async function checkUwpInstalled(pkgFamilyAppId) {
  const pkgFamily = pkgFamilyAppId.split('!')[0];
  try {
    const out = await psExec(`Get-AppxPackage -Name '${pkgFamily.split('_')[0]}*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PackageFamilyName -First 1`);
    return out.trim().length > 0;
  } catch { return false; }
}

/**
 * Find the first installed tool for a vendor.
 * Returns { kind: 'exe'|'uwp', target: string } or null.
 */
async function findVendorTool(vendor) {
  const tools = VENDOR_TOOLS[vendor] || [];
  for (const t of tools) {
    if (t.exe) {
      try { await fs.promises.access(t.exe); return { kind: 'exe', target: t.exe }; } catch {}
    } else if (t.uwp) {
      if (await checkUwpInstalled(t.uwp)) return { kind: 'uwp', target: t.uwp };
    }
  }
  return null;
}

ipcMain.handle('check-fps-cap', async (_event, { gameDir } = {}) => {
  let dxvkApplied = false;
  if (gameDir) {
    try {
      const { map } = await readDxvkConf(gameDir);
      dxvkApplied = map.get(FPS_CAP_KEY) === FPS_CAP_VALUE;
    } catch {}
  }
  const vendor = await detectGpuVendor();
  const tool   = await findVendorTool(vendor);
  return {
    dxvkApplied,
    vendor,
    vendorToolAvailable: !!tool,
    vendorToolKind:      tool?.kind || null,
  };
});

ipcMain.handle('apply-fps-cap', async (_event, { gameDir, enable } = {}) => {
  if (!gameDir) return { success: false, error: 'No game directory' };
  try {
    const { confPath, map } = await readDxvkConf(gameDir);
    if (enable) {
      map.set(FPS_CAP_KEY, FPS_CAP_VALUE);
    } else {
      map.delete(FPS_CAP_KEY);
    }
    const content = stringifyDxvkConf(map);
    if (content) {
      await fs.promises.writeFile(confPath, content, 'utf-8');
    } else {
      try { await fs.promises.unlink(confPath); } catch {}
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─────────────────────────────────────────────
// Long-session reminder for DP.exe
//
// The audio-load-request pool (TPoolList<LOADREQUEST_ITEM, 64, 0>) leaks
// slots on every crashed cutscene; after a few hours of play the pool
// gets close to its 64-slot capacity and the next allocation crashes
// the game on a null deref (see docs/AUDIO_POOL_LEAK.md).
//
// We attempted to fix this in-binary in v1.2.0/v1.2.1 but the surgical
// hex patch broke save-loading (TPopList::Pop returns garbage non-null
// pointers in some paths, defeating our null-check). Reverted.
//
// Instead we ship a soft reminder: poll for DP.exe every minute, after
// 3 hours of uptime fire a one-time 'session-warning' IPC event to the
// renderer. The renderer surfaces a toast suggesting "restart the game
// to drain the audio pool".
// ─────────────────────────────────────────────
const SESSION_WARN_AFTER_MS = 3 * 60 * 60 * 1000;   // 3 hours
const SESSION_POLL_MS       = 60 * 1000;              // 1 minute
let   sessionDpStart        = null;
let   sessionWarningSent    = false;
let   sessionPollTimer      = null;

function isDpRunning() {
  return new Promise((resolve) => {
    require('child_process').exec(
      'tasklist /FI "IMAGENAME eq DP.exe" /NH /FO CSV',
      { windowsHide: true },
      (err, stdout) => resolve(!err && /dp\.exe/i.test(stdout || '')),
    );
  });
}

sessionPollTimer = setInterval(async () => {
  const running = await isDpRunning();
  if (running) {
    if (!sessionDpStart) {
      sessionDpStart     = Date.now();
      sessionWarningSent = false;
    }
    const elapsedMs = Date.now() - sessionDpStart;
    if (elapsedMs >= SESSION_WARN_AFTER_MS && !sessionWarningSent) {
      sessionWarningSent = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('session-warning', { elapsedMs });
      }
    }
  } else {
    // DP.exe not running → reset session tracking
    sessionDpStart     = null;
    sessionWarningSent = false;
  }
}, SESSION_POLL_MS);

// ─────────────────────────────────────────────
// IPC – DXVK Shader Cache info / cleanup
//
// DXVK writes a state cache file as `<exe_name>.dxvk-cache` next to the
// game executable (default behavior; env DXVK_STATE_CACHE_PATH overrides).
// Cache grows as new shader pipelines are compiled — first playthrough of
// each area produces stutter; subsequent runs hit the cache and stutter
// disappears. We expose:
//   - read-only info (count, total size, newest mtime)
//   - cleanup (delete all *.dxvk-cache files in the game directory)
//
// We do NOT touch the bundled DXVK distribution under <gameDir>/_dxvk-cache/
// — that folder contains the extracted release (DLLs), not the runtime
// shader cache.
// ─────────────────────────────────────────────
async function findDxvkCacheFiles(gameDir) {
  const entries = await fs.promises.readdir(gameDir, { withFileTypes: true }).catch(() => []);
  const results = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!/\.dxvk-cache$/i.test(e.name)) continue;
    const full = path.join(gameDir, e.name);
    try {
      const st = await fs.promises.stat(full);
      results.push({ name: e.name, path: full, size: st.size, mtime: st.mtime.toISOString() });
    } catch {}
  }
  return results;
}

/** Sum up sizes & newest mtime of all files under a directory tree. */
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

ipcMain.handle('dxvk-cache-info', async (_event, { gameDir } = {}) => {
  // DXVK state cache (per-game file)
  let dxvkFiles = [];
  let dxvkTotal = 0;
  let dxvkMtime = null;
  if (gameDir) {
    dxvkFiles = await findDxvkCacheFiles(gameDir);
    dxvkTotal = dxvkFiles.reduce((a, f) => a + f.size, 0);
    dxvkMtime = dxvkFiles.length
      ? dxvkFiles.map(f => f.mtime).sort().reverse()[0]
      : null;
  }

  // GPU-driver-level shader caches (shared across all games). We report
  // these informationally so the user understands where shaders actually
  // live on modern systems — NVIDIA DXCache is the real heavy lifter.
  // Parallel-dispatch the three recursive directory scans into the heavy
  // worker so a 10k+ file NVIDIA DXCache doesn't block the IPC event loop.
  const homeDir = app.getPath('home');
  const [nvidiaDxCache, nvidiaGlCache, amdShaderCache] = await Promise.all([
    runHeavyTask('fs:describe-dir-size', { dir: path.join(homeDir, 'AppData', 'Local', 'NVIDIA', 'DXCache') }),
    runHeavyTask('fs:describe-dir-size', { dir: path.join(homeDir, 'AppData', 'Local', 'NVIDIA', 'GLCache') }),
    runHeavyTask('fs:describe-dir-size', { dir: path.join(homeDir, 'AppData', 'Local', 'AMD',    'DxCache') }),
  ]);
  const driver = { nvidiaDxCache, nvidiaGlCache, amdShaderCache };

  return {
    dxvk: {
      files:       dxvkFiles,
      totalSize:   dxvkTotal,
      newestMtime: dxvkMtime,
    },
    driver,
  };
});

// ─────────────────────────────────────────────
// IPC – DPfix CaptureCursor toggle
//
// DPfix has an internal setting `CaptureCursor` (in Settings.def from
// PeterTh/dpfix) that grabs the cursor at the D3D9 wrapper layer. It's
// undocumented in the shipped DPfix.ini but the parser respects it.
// Setting `CaptureCursor 1` is a cleaner cursor-hide path than our
// PS AttachThreadInput watcher when DPfix is active (i.e. the user's
// d3d9.dll is the DPfix proxy, possibly chained to DXVK via d9vk.dll).
//
// We don't roundtrip the whole INI through the parser — comment lines
// matter (they're documentation). Instead we surgically:
//   - Look for an existing CaptureCursor line (commented or not) → replace
//   - If not present → append at end of file
// Both forms ("CaptureCursor 0" / "CaptureCursor 1") are valid; absence
// means default 0.
// ─────────────────────────────────────────────
const CAPTURE_CURSOR_RE = /^(\s*)(#\s*)?CaptureCursor\b.*$/im;

async function readDpfixIni(gameDir) {
  const iniPath = path.join(gameDir, 'DPfix.ini');
  try {
    const text = await fs.promises.readFile(iniPath, 'utf-8');
    return { iniPath, text };
  } catch {
    return { iniPath, text: null };
  }
}

ipcMain.handle('check-capture-cursor', async (_event, { gameDir } = {}) => {
  if (!gameDir) return { iniExists: false, applied: false };
  const { text } = await readDpfixIni(gameDir);
  if (text === null) return { iniExists: false, applied: false };
  // Find a non-commented CaptureCursor X line
  const m = text.match(/^\s*CaptureCursor\s+(\d+)\s*$/im);
  return {
    iniExists: true,
    applied:   !!m && m[1] === '1',
    rawValue:  m ? m[1] : null,
  };
});

ipcMain.handle('apply-capture-cursor', async (_event, { gameDir, enable } = {}) => {
  if (!gameDir) return { success: false, error: 'No game directory' };
  const { iniPath, text } = await readDpfixIni(gameDir);
  if (text === null) {
    return { success: false, error: 'DPfix.ini not found in game directory.' };
  }
  // Backup .ini once
  const bakPath = iniPath + '.bak';
  try { await fs.promises.access(bakPath); }
  catch { await fs.promises.writeFile(bakPath, text, 'utf-8'); }

  const newLine = `CaptureCursor ${enable ? 1 : 0}`;
  let next;
  if (CAPTURE_CURSOR_RE.test(text)) {
    // Replace existing line (uncomments if was commented)
    next = text.replace(CAPTURE_CURSOR_RE, newLine);
  } else {
    // Append at end with a marker comment so future runs can find it
    const trailingNl = text.endsWith('\n') ? '' : '\n';
    next = text + trailingNl +
      '\n# Added by DP1 Launcher — capture cursor at the D3D9 wrapper level\n' +
      newLine + '\n';
  }
  if (next === text) return { success: true, alreadyApplied: true };
  await fs.promises.writeFile(iniPath, next, 'utf-8');
  return { success: true };
});

ipcMain.handle('dxvk-cache-clean', async (_event, { gameDir } = {}) => {
  if (!gameDir) return { success: false, error: 'No game directory' };
  const files = await findDxvkCacheFiles(gameDir);
  if (!files.length) return { success: true, deleted: 0 };
  let deleted = 0;
  const errors = [];
  for (const f of files) {
    try { await fs.promises.unlink(f.path); deleted++; }
    catch (err) { errors.push(`${f.name}: ${err.message}`); }
  }
  return { success: errors.length === 0, deleted, errors };
});

// Opens the Windows Sound control panel (mmsys.cpl). The "tab" parameter
// chooses which tab to land on:
//   'playback'  — for picking the stereo speaker config
//   'recording' — for the Stereo Mix loopback workaround on 7.1 headphones
// We launch via `control.exe` which is the documented entry point for
// .cpl applets and respects the `,,N` tab-index parameter.
ipcMain.handle('open-sound-settings', async (_event, { tab } = {}) => {
  // `control` needs the tab parameter concatenated as a single token:
  // `mmsys.cpl,,N` (no spaces) — passing as separate execFile args breaks it.
  // We pass ONE argument; spaces matter zero here.
  const tabIndex = tab === 'recording' ? '1' : '0';   // 0=Playback, 1=Recording
  return new Promise((resolve) => {
    require('child_process').execFile(
      'control.exe',
      [`mmsys.cpl,,${tabIndex}`],
      { windowsHide: false },
      (err) => {
        if (err) resolve({ success: false, error: err.message });
        else     resolve({ success: true });
      }
    );
  });
});

ipcMain.handle('open-gpu-settings', async (_event, { vendor } = {}) => {
  const tool = await findVendorTool(vendor);
  if (!tool) {
    return { success: false, error: `Control panel not found for vendor: ${vendor}` };
  }
  if (tool.kind === 'uwp') {
    // Launch UWP app via shell:appsFolder. explorer.exe is the canonical way.
    return new Promise((resolve) => {
      require('child_process').execFile(
        'explorer.exe',
        [`shell:appsFolder\\${tool.target}`],
        { windowsHide: false },
        (err) => {
          // explorer.exe returns non-zero even on success for shell URIs — treat any launch as ok.
          resolve({ success: true });
        }
      );
    });
  }
  // exe
  return new Promise((resolve) => {
    require('child_process').execFile(tool.target, [], { windowsHide: false }, (err) => {
      if (err) resolve({ success: false, error: err.message });
      else     resolve({ success: true });
    });
  });
});

// ─────────────────────────────────────────────
// IPC – Codec Fix (session-scoped DirectShow merit lowering for LAV)
//
// K-Lite installs LAV Filters which register with higher DirectShow merit
// than Microsoft's native WMV/VC-1 decoders. On Win11 + RTX 50-series,
// LAV's WMV decoder path can crash DP.exe during cutscene playback.
//
// Instead of permanently lowering LAV merits (which would affect every
// other DirectShow-using app on the system: MPC-HC, Potplayer, OBS…),
// we spawn a detached PowerShell watcher that:
//
//   1. Backs up each LAV filter's FilterData (original merit) into both
//      memory and a JSON file under %APPDATA%/DP1Launcher.
//   2. Writes MERIT_DO_NOT_USE (0x00200000) into bytes 4..7 of FilterData
//      → Microsoft codecs win the filter graph race during this session.
//   3. Waits for DP.exe to start (up to 60 s) then waits for it to exit.
//   4. Restores every FilterData byte-for-byte. Deletes the backup file.
//
// On next start, if the previous session crashed mid-game, the watcher
// detects the lingering backup file and restores it first thing —
// belt-and-suspenders against orphaned patches.
//
// HKLM writes require admin; caller should ensure the launcher was
// elevated (electronAPI.relaunchAsAdmin) before invoking.
// ─────────────────────────────────────────────
const LAV_FILTER_CLSIDS = [
  '{EE30215D-164F-4A92-A4EB-9D4C13390F9F}', // LAV Video
  '{E8E73B6B-4CB3-44A4-BE99-4F7BCB96E491}', // LAV Audio
  '{171252A0-8820-4AFE-9DF8-5C92B2D66B04}', // LAV Splitter
  '{B98D13E7-55DB-4385-A33D-09FD1BA26339}', // LAV Splitter Source
];
const DSHOW_FILTERS_CATEGORY = '{083863F1-70DE-11D0-BD40-00A0C911CE86}';

let codecWatcherProc = null;

function codecWatcherScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dpc_codec_watcher.ps1')
    : path.join(__dirname, 'assets', 'dpc_codec_watcher.ps1');
}

ipcMain.handle('check-codec-fix', async () => {
  // Returns: { lavInstalled, sessionActive, present: [{ clsid, merit }] }
  const script = LAV_FILTER_CLSIDS.map(clsid => `
    $p = "HKLM:\\SOFTWARE\\Classes\\CLSID\\${DSHOW_FILTERS_CATEGORY}\\Instance\\${clsid}";
    if (Test-Path $p) {
      $d = (Get-ItemProperty -Path $p -Name 'FilterData' -ErrorAction SilentlyContinue).FilterData;
      if ($d -and $d.Length -ge 8) {
        $merit = [BitConverter]::ToUInt32($d, 4);
        Write-Output "${clsid}:$merit";
      }
    }
  `).join('');
  try {
    const out = await psExec(script);
    const present = [];
    out.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
      const [clsid, meritStr] = line.split(':');
      present.push({ clsid, merit: parseInt(meritStr, 10) });
    });
    return {
      lavInstalled:  present.length > 0,
      sessionActive: !!(codecWatcherProc && !codecWatcherProc.killed),
      present,
    };
  } catch (err) {
    return { lavInstalled: false, sessionActive: false, error: err.message };
  }
});

ipcMain.handle('start-codec-fix', async (_event, { processName = 'DP' } = {}) => {
  if (codecWatcherProc && !codecWatcherProc.killed) {
    return { success: true, alreadyRunning: true };
  }
  const scriptPath = codecWatcherScriptPath();
  try { await fs.promises.access(scriptPath); }
  catch { return { success: false, error: `Watcher script not found at ${scriptPath}` }; }

  const backupFile = path.join(app.getPath('userData'), 'codec-session-backup.json');
  const { spawn } = require('child_process');
  codecWatcherProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-ProcessName', processName,
    '-BackupFile',  backupFile,
  ], { detached: true, windowsHide: true, stdio: 'ignore' });
  codecWatcherProc.unref();
  codecWatcherProc.on('exit', () => { codecWatcherProc = null; });
  return { success: true };
});

ipcMain.handle('stop-codec-fix', async () => {
  if (codecWatcherProc && !codecWatcherProc.killed) {
    // PS watcher's `finally` block restores originals on exit.
    try { codecWatcherProc.kill(); } catch {}
    codecWatcherProc = null;
    return { success: true };
  }
  return { success: true, notRunning: true };
});

// ─────────────────────────────────────────────
// IPC – Hide cursor while game is in foreground
//
// Spawns a detached PowerShell watcher that uses AttachThreadInput to
// hide DP.exe's window cursor whenever DP.exe is the foreground window.
// When the game exits, the watcher restores the cursor and dies.
// ─────────────────────────────────────────────
let cursorWatcherProc = null;

ipcMain.handle('start-cursor-hide', async (_event, { processName = 'DP' } = {}) => {
  if (cursorWatcherProc && !cursorWatcherProc.killed) {
    return { success: true, alreadyRunning: true };
  }
  // PS1 must live outside asar so powershell.exe can read it. We ship it
  // via electron-builder's extraResources / electron-packager's --extra-resource,
  // so when packaged it sits flat in process.resourcesPath; in dev it's
  // under assets/ next to the source.
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'dpc_cursor_hide.ps1')
    : path.join(__dirname, 'assets', 'dpc_cursor_hide.ps1');
  try { await fs.promises.access(scriptPath); }
  catch { return { success: false, error: `Watcher script not found at ${scriptPath}` }; }

  const { spawn } = require('child_process');
  cursorWatcherProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-ProcessName', processName,
  ], { detached: true, windowsHide: true, stdio: 'ignore' });
  cursorWatcherProc.unref();
  cursorWatcherProc.on('exit', () => { cursorWatcherProc = null; });
  return { success: true };
});

ipcMain.handle('stop-cursor-hide', async () => {
  if (cursorWatcherProc && !cursorWatcherProc.killed) {
    try { cursorWatcherProc.kill(); } catch {}
    cursorWatcherProc = null;
    return { success: true };
  }
  return { success: true, notRunning: true };
});

// ─────────────────────────────────────────────
// IPC – Toggle Steam Overlay for a specific Steam app
//
// Edits <SteamPath>/userdata/<UserID>/config/localconfig.vdf, locating the
// app's entry under  Software → Valve → Steam → apps → "<appId>"  and
// flipping the "OverlayAppEnable" key.
//
// IMPORTANT: Steam locks localconfig.vdf while running and will overwrite
// changes on next exit. Caller should ensure Steam is closed; we still
// write a .bak just in case.
// ─────────────────────────────────────────────
async function findSteamRoot() {
  const candidates = new Set();
  const tryAdd = (p) => { if (p) candidates.add(p.replace(/[\\/]+$/, '')); };
  tryAdd(process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'));
  tryAdd(process.env['ProgramFiles']      && path.join(process.env['ProgramFiles'],      'Steam'));
  tryAdd('C:\\Program Files (x86)\\Steam');
  tryAdd('C:\\Program Files\\Steam');
  if (process.platform === 'win32') {
    try {
      const out = await psExec(
        "$p = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam' -Name 'InstallPath' -ErrorAction SilentlyContinue).InstallPath; " +
        "if (-not $p) { $p = (Get-ItemProperty -Path 'HKCU:\\SOFTWARE\\Valve\\Steam' -Name 'SteamPath' -ErrorAction SilentlyContinue).SteamPath }; " +
        "if ($p) { Write-Output $p }"
      );
      if (out) tryAdd(out.trim().replace(/\//g, '\\'));
    } catch {}
  }
  for (const c of candidates) {
    try { await fs.promises.access(c); return c; } catch {}
  }
  return null;
}

/** Brace-match a "<startMarker>" { ... } block in VDF text. */
function findVdfBlock(text, startMarker) {
  const idx = text.indexOf(startMarker);
  if (idx === -1) return null;
  let i = idx + startMarker.length;
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return null;
  const blockStart = i;
  let depth = 0, j = blockStart;
  while (j < text.length) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') { depth--; if (depth === 0) return { start: idx, blockStart, blockEnd: j }; }
    j++;
  }
  return null;
}

function setOverlayKeyInVdf(vdf, appId, enabled) {
  const block = findVdfBlock(vdf, `"${appId}"`);
  if (!block) return null;
  const body = vdf.slice(block.blockStart + 1, block.blockEnd);
  const keyRe = /(["']OverlayAppEnable["']\s*["'])([01])(["'])/i;
  const v = enabled ? '1' : '0';
  let newBody;
  if (keyRe.test(body)) {
    newBody = body.replace(keyRe, `$1${v}$3`);
  } else {
    // Append before closing whitespace
    newBody = body.replace(/(\s*)$/, `\n\t\t\t\t\t"OverlayAppEnable"\t\t"${v}"$1`);
  }
  return vdf.slice(0, block.blockStart + 1) + newBody + vdf.slice(block.blockEnd);
}

ipcMain.handle('set-steam-overlay', async (_event, { appId, enabled }) => {
  const id = String(appId ?? '').trim();
  if (!/^\d{1,12}$/.test(id)) return { success: false, error: 'invalid app id' };

  const steamRoot = await findSteamRoot();
  if (!steamRoot) return { success: false, error: 'Steam install not found' };

  const userdataDir = path.join(steamRoot, 'userdata');
  let users;
  try { users = await fs.promises.readdir(userdataDir, { withFileTypes: true }); }
  catch { return { success: false, error: 'No Steam userdata folder' }; }

  const userDirs = users.filter(u => u.isDirectory() && /^\d+$/.test(u.name));
  if (!userDirs.length) return { success: false, error: 'No Steam users found' };

  let touched = 0;
  const failures = [];
  for (const u of userDirs) {
    const configPath = path.join(userdataDir, u.name, 'config', 'localconfig.vdf');
    try {
      const original = await fs.promises.readFile(configPath, 'utf-8');
      const updated  = setOverlayKeyInVdf(original, id, enabled);
      if (!updated) {
        failures.push(`user ${u.name}: app "${id}" entry not found`);
        continue;
      }
      // Backup once
      const bak = configPath + '.dp1-backup';
      try { await fs.promises.access(bak); }
      catch { await fs.promises.writeFile(bak, original, 'utf-8'); }
      await fs.promises.writeFile(configPath, updated, 'utf-8');
      touched++;
    } catch (err) {
      failures.push(`user ${u.name}: ${err.code === 'EBUSY' ? 'file locked (Steam running?)' : err.message}`);
    }
  }

  return {
    success: touched > 0,
    touched,
    failures,
    note: 'If Steam is open it may overwrite this change on exit — close Steam first for it to stick.',
  };
});

async function findDxvkSourceDll(gameDir) {
  const cacheDir = path.join(gameDir, '_dxvk-cache');
  try {
    const entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !/^dxvk-/i.test(e.name)) continue;
      const candidate = path.join(cacheDir, e.name, 'x32', 'd3d9.dll');
      try { await fs.promises.access(candidate); return candidate; } catch {}
    }
  } catch {}
  return null;
}

ipcMain.handle('apply-dxvk-auto', async (_event, { gameDir }) => {
  // 1) Locate DXVK x32/d3d9.dll from cache
  const src = await findDxvkSourceDll(gameDir);
  if (!src) return { success: false, error: 'DXVK source not found in _dxvk-cache' };

  // 2) Copy to SysWOW64\d9vk.dll  (admin required)
  try {
    await fs.promises.copyFile(src, DXVK_SYS_TARGET);
  } catch (err) {
    return {
      success: false,
      error: err.code === 'EPERM' || err.code === 'EACCES'
        ? 'Потрібні права адміністратора для запису до SysWOW64'
        : err.message,
    };
  }

  // 3) Hex-edit game's d3d9.dll (DPfix-installed): 'd3d9.dll' → 'd9vk.dll'
  const gameDll = path.join(gameDir, 'd3d9.dll');
  let buf;
  try { buf = await fs.promises.readFile(gameDll); }
  catch (err) { return { success: false, error: 'Не знайдено DPfix d3d9.dll у папці гри' }; }

  // Backup the DPfix d3d9.dll (idempotent across launcher versions —
  // resolveBackup migrates any old <file>.bak into exe_backup/ first).
  await makeBackup(gameDll, BACKUP_LABELS.d3d9DpfixOnly);

  const search  = Buffer.from('d3d9.dll', 'ascii');
  const replace = Buffer.from('d9vk.dll', 'ascii');
  let pos = 0;
  let count = 0;
  while ((pos = buf.indexOf(search, pos)) !== -1) {
    replace.copy(buf, pos);
    pos += replace.length;
    count++;
  }

  if (count === 0) {
    return {
      success: false,
      error: 'Не знайдено посилань "d3d9.dll" у файлі — можливо, DPfix уже патчили раніше',
    };
  }

  await fs.promises.writeFile(gameDll, buf);
  return { success: true, replacements: count };
});

// ─────────────────────────────────────────────
// IPC – Revert DXVK (full undo of apply-dxvk-auto, plus deletes the DLLs).
//
// Reverses every step of the apply flow, in opposite order:
//   1) Restore <gameDir>/d3d9.dll from exe_backup/d3d9.dll_dpfix_only
//      (resolveBackup migrates legacy .bak files into exe_backup/ first;
//      falls back to in-place 'd9vk.dll' → 'd3d9.dll' hex-revert if no backup).
//   2) Delete the backup file once restore is confirmed.
//   3) Delete C:\Windows\SysWOW64\d9vk.dll  (admin required).
// ─────────────────────────────────────────────
ipcMain.handle('revert-dxvk-auto', async (_event, { gameDir }) => {
  if (!gameDir) return { success: false, error: 'No game folder' };
  const gameDll = path.join(gameDir, 'd3d9.dll');
  const steps   = [];

  // 1) Restore game's d3d9.dll from exe_backup/d3d9.dll_dpfix_only
  //    (resolveBackup also migrates any legacy d3d9.dll.bak into the
  //    new exe_backup/ location before returning its path).
  const bakResolved = await resolveBackup(gameDll, BACKUP_LABELS.d3d9DpfixOnly);
  if (bakResolved) {
    try {
      await fs.promises.copyFile(bakResolved, gameDll);
      steps.push(`Restored game d3d9.dll from ${path.relative(gameDir, bakResolved)}`);
    } catch (err) {
      return { success: false, error: `Cannot restore game d3d9.dll: ${err.message}`, steps };
    }
  } else {
    // No backup — try in-place hex-reverse 'd9vk.dll' → 'd3d9.dll'
    try {
      const buf = await fs.promises.readFile(gameDll);
      const search  = Buffer.from('d9vk.dll', 'ascii');
      const replace = Buffer.from('d3d9.dll', 'ascii');
      let pos = 0, count = 0;
      while ((pos = buf.indexOf(search, pos)) !== -1) {
        replace.copy(buf, pos);
        pos += replace.length;
        count++;
      }
      if (count === 0) {
        steps.push('Game d3d9.dll already unpatched');
      } else {
        await fs.promises.writeFile(gameDll, buf);
        steps.push(`Hex-reverted d3d9.dll in place (${count} refs)`);
      }
    } catch (err) {
      return { success: false, error: `Cannot restore game d3d9.dll: ${err.message}`, steps };
    }
  }

  // 2) Cleanup the backup file (best-effort) once restore is confirmed.
  if (bakResolved) {
    try {
      await fs.promises.unlink(bakResolved);
      steps.push(`Removed ${path.relative(gameDir, bakResolved)}`);
    } catch { /* missing is fine */ }
  }

  // 3) Delete SysWOW64\d9vk.dll
  try {
    await fs.promises.unlink(DXVK_SYS_TARGET);
    steps.push('Removed SysWOW64\\d9vk.dll');
  } catch (err) {
    if (err.code === 'ENOENT') {
      steps.push('SysWOW64\\d9vk.dll already absent');
    } else if (err.code === 'EPERM' || err.code === 'EACCES') {
      return {
        success: false,
        error: 'Adminstrator rights required to remove SysWOW64\\d9vk.dll',
        steps,
      };
    } else {
      return { success: false, error: err.message, steps };
    }
  }

  return { success: true, steps };
});

// Detection helper for the DXVK revert button: was DXVK applied via this
// launcher? (Either the system DLL exists, the game's d3d9.dll has been
// hex-patched, or both. .bak presence is also a strong signal.)
ipcMain.handle('check-dxvk-applied', async (_event, { gameDir }) => {
  const result = { systemDll: false, gamePatched: false, bakExists: false };
  if (!gameDir) return { ...result, applied: false };
  try { await fs.promises.access(DXVK_SYS_TARGET); result.systemDll = true; } catch {}
  const gameDll = path.join(gameDir, 'd3d9.dll');
  try {
    const buf = await fs.promises.readFile(gameDll);
    result.gamePatched = buf.indexOf(Buffer.from('d9vk.dll', 'ascii')) !== -1;
  } catch {}
  // Check both the new exe_backup location and the legacy <file>.bak.
  try { await fs.promises.access(backupPath(gameDir, BACKUP_LABELS.d3d9DpfixOnly)); result.bakExists = true; } catch {}
  if (!result.bakExists) {
    try { await fs.promises.access(gameDll + '.bak'); result.bakExists = true; } catch {}
  }
  result.applied = result.systemDll || result.gamePatched || result.bakExists;
  return result;
});

// ─────────────────────────────────────────────
// IPC – Admin detection & elevation
//
// Previously used execSync('net session') which blocked the IPC event loop
// for 1-2 seconds on every app start. Now uses async exec().
// ─────────────────────────────────────────────
ipcMain.handle('is-admin', () => {
  return new Promise((resolve) => {
    require('child_process').exec(
      'net session',
      { windowsHide: true },
      (err) => resolve(!err)
    );
  });
});

ipcMain.handle('relaunch-as-admin', () => {
  const { exec } = require('child_process');
  // Escape single quotes in path
  const exePath = process.execPath.replace(/'/g, "''");

  return new Promise((resolve) => {
    // execSync-style via exec: wait for powershell to finish before deciding to quit.
    // Start-Process without -Wait returns immediately after UAC is accepted/declined.
    const ps = exec(
      `powershell.exe -NoProfile -NonInteractive -Command "Start-Process -FilePath '${exePath}' -Verb RunAs"`,
      { windowsHide: true }
    );

    ps.on('exit', (code) => {
      if (code === 0) {
        // UAC accepted — new elevated instance is starting, close current one
        resolve({ accepted: true });
        app.quit();
      } else {
        // UAC declined or error — stay open
        resolve({ accepted: false });
      }
    });

    ps.on('error', (err) => {
      console.error('[relaunch-as-admin] error:', err);
      resolve({ accepted: false, error: err.message });
    });
  });
});

// ─────────────────────────────────────────────
// IPC – Compatibility mode (registry)
// Supported modes: 'xpsp3' (default), 'win98'
// ─────────────────────────────────────────────
const COMPAT_VALUES = {
  xpsp3: '~ WINXPSP3',
  win98: '~ WIN98',
};

/**
 * Execute a PowerShell script safely via -EncodedCommand (Base64 UTF-16LE).
 * This avoids ALL quoting/escaping issues regardless of special chars in paths
 * (spaces, apostrophes like "Director's Cut", Cyrillic, etc.)
 */
function psExec(script) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { windowsHide: true, encoding: 'utf-8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout.trim());
      }
    );
  });
}

/** Escape a Windows path for use inside a PowerShell double-quoted string */
function psEscPath(p) {
  return p.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"');
}

ipcMain.handle('get-compat-status', async (_event, exePath) => {
  try {
    const ep  = psEscPath(exePath);
    const out = await psExec(
      `$v = (Get-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers" -Name "${ep}" -ErrorAction SilentlyContinue)."${ep}"; Write-Output $v`
    );
    if (out.includes('WINXPSP3')) return 'xpsp3';
    if (out.includes('WIN98'))    return 'win98';
    return 'none';
  } catch {
    return 'none';
  }
});

ipcMain.handle('set-compat', async (_event, exePath, mode = 'xpsp3') => {
  const value = COMPAT_VALUES[mode] || COMPAT_VALUES.xpsp3;
  const ep = psEscPath(exePath);
  await psExec(`
$key = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name "${ep}" -Value "${value}" -Type String
Write-Output 'ok'
`);
});

ipcMain.handle('remove-compat', async (_event, exePath) => {
  const ep = psEscPath(exePath);
  await psExec(`
$key = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers"
Remove-ItemProperty -Path $key -Name "${ep}" -ErrorAction SilentlyContinue
Write-Output 'ok'
`);
});

// ─────────────────────────────────────────────
// IPC – DXVK (d9vk.dll → SysWOW64)
// All file operations are async (fs.promises) — non-blocking via libuv thread pool.
// ─────────────────────────────────────────────
const DXVK_TARGET = path.join('C:\\Windows\\SysWOW64', 'd9vk.dll');

ipcMain.handle('check-dxvk', async () => {
  try {
    await fs.promises.access(DXVK_TARGET);
    return true;
  } catch {
    return false;
  }
});

/** Returns the bundled d9vk.dll path from resources (outside asar) */
ipcMain.handle('get-bundled-dxvk', async () => {
  const p = path.join(process.resourcesPath, 'd9vk.dll');
  try {
    await fs.promises.access(p);
    return p;
  } catch {
    return null;
  }
});

// DLL copy can be 5-15 MB — async is critical here to avoid freezing the UI.
ipcMain.handle('install-dxvk', async (_event, sourcePath) => {
  await fs.promises.copyFile(sourcePath, DXVK_TARGET);
  return true;
});

ipcMain.handle('uninstall-dxvk', async () => {
  try {
    await fs.promises.unlink(DXVK_TARGET);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // ignore "file not found"
  }
  return true;
});

ipcMain.handle('browse-dll', async () => {
  if (!mainWindow) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Вибрати d9vk.dll',
    filters:    [{ name: 'DLL Files', extensions: ['dll'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

// ─────────────────────────────────────────────
// IPC – 4GB LAA patch
// ─────────────────────────────────────────────
ipcMain.handle('run-4gb-patch', async (_event, targetExe) => {
  const patchExe = path.join(process.resourcesPath, '4gb_patch.exe');
  const { exec }  = require('child_process');

  // Run via cmd /c — bypasses Windows zone/security restrictions on spawned exes
  const cmd = `"${patchExe}" "${targetExe}"`;

  return new Promise((resolve) => {
    exec(cmd, { cwd: path.dirname(patchExe), windowsHide: false }, async (err, stdout, stderr) => {
      if (err) { resolve({ success: false, error: err.message }); return; }
      try { await migrateNTCore4gbBackup(targetExe); } catch {}
      resolve({ success: true });
    });
  });
});

// ─────────────────────────────────────────────
// IPC – Install redist (DirectX, PhysX, VCRedist)
// fs.promises.readdir + fs.promises.access — non-blocking directory scan.
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// IPC – Autosave (save-game backup via Worker)
// ─────────────────────────────────────────────
function getSaveWorker() {
  if (saveWorker) return saveWorker;
  saveWorker = new Worker(path.join(__dirname, 'workers', 'save-worker.js'));
  saveWorker.on('error', (err) => { console.error('[SaveWorker] Error:', err); saveWorker = null; });
  saveWorker.on('exit', () => { saveWorker = null; });
  saveWorker.on('message', (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('autosave-event', msg);
    }
  });
  return saveWorker;
}

ipcMain.handle('autosave-start', (_event, gameDir, interval) => {
  getSaveWorker().postMessage({ type: 'start', gameDir, interval });
});

ipcMain.handle('autosave-stop', () => {
  if (saveWorker) saveWorker.postMessage({ type: 'stop' });
});

/**
 * Read a small set of known-meaningful bytes from a dp.sav file.
 * Offsets and meanings come from community RE on Steam Discussions
 * (Erroneous Syntax / Dengarde / Zeddikins, Oct 2013).
 */
async function readSaveMeta(savFile) {
  let fh;
  try {
    fh = await fs.promises.open(savFile, 'r');
    // Single tiny read covering both bytes of interest. 0x19C model byte
    // and 0x5CA character byte are both inside the first 1.5 KB.
    const buf = Buffer.alloc(0x600);
    const { bytesRead } = await fh.read(buf, 0, 0x600, 0);
    if (bytesRead < 0x5CB) return { character: null };
    return {
      character: buf[0x5CA],
      modelByte: buf[0x19C],
    };
  } catch {
    return { character: null };
  } finally {
    try { await fh?.close(); } catch {}
  }
}

/** List all backup folders with metadata */
ipcMain.handle('saves-list', async (_event, gameDir) => {
  const backupsDir = path.join(gameDir, 'savedata', 'backups');
  const metaPath   = path.join(backupsDir, 'meta.json');

  let meta = {};
  try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8')); } catch { /* none yet */ }

  let entries = [];
  try {
    const dirs = await fs.promises.readdir(backupsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const savFile = path.join(backupsDir, d.name, 'dp.sav');
      try {
        const stat = await fs.promises.stat(savFile);
        const saveMeta = await readSaveMeta(savFile);
        entries.push({
          id:          d.name,
          date:        stat.mtime.toISOString(),
          size:        stat.size,
          description: meta[d.name] || '',
          character:   saveMeta.character,
          modelByte:   saveMeta.modelByte,
        });
      } catch { /* no dp.sav inside — skip */ }
    }
  } catch { /* backups dir missing */ }

  // Sort newest first
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
});

/** Restore a backup to the game savedata folder */
ipcMain.handle('saves-restore', async (_event, gameDir, backupId) => {
  const src  = path.join(gameDir, 'savedata', 'backups', backupId, 'dp.sav');
  const dest = path.join(gameDir, 'savedata', 'dp.sav');
  await fs.promises.copyFile(src, dest);
  return true;
});

/** Delete a backup folder */
ipcMain.handle('saves-delete', async (_event, gameDir, backupId) => {
  const dir = path.join(gameDir, 'savedata', 'backups', backupId);
  await fs.promises.rm(dir, { recursive: true, force: true });

  // Remove from meta
  const metaPath = path.join(gameDir, 'savedata', 'backups', 'meta.json');
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
    delete meta[backupId];
    await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  } catch { /* ok */ }
  return true;
});

/** Update description for a backup */
ipcMain.handle('saves-set-desc', async (_event, gameDir, backupId, description) => {
  const metaPath = path.join(gameDir, 'savedata', 'backups', 'meta.json');
  let meta = {};
  try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8')); } catch { /* none yet */ }
  if (description) meta[backupId] = description;
  else delete meta[backupId];
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  return true;
});

ipcMain.handle('install-redist', async (_event, gameDir) => {
  const { exec } = require('child_process');
  const redistDir = path.join(gameDir, 'redist');

  const runInstaller = (exePath) => new Promise((resolve) => {
    exec(`"${exePath}"`, { cwd: path.dirname(exePath), windowsHide: false }, (err) => {
      resolve({ file: path.basename(exePath), success: !err, error: err?.message });
    });
  });

  /** Check whether a file exists without blocking the event loop */
  const exists = async (p) => {
    try { await fs.promises.access(p); return true; } catch { return false; }
  };

  const results = [];

  // DXSETUP.exe
  const dxSetup = path.join(redistDir, 'DXSETUP.exe');
  if (await exists(dxSetup)) results.push(await runInstaller(dxSetup));

  // PhysX_SystemSoftware*.exe
  try {
    const files = await fs.promises.readdir(redistDir);
    const physx = files.find(f => /^PhysX_SystemSoftware.*\.exe$/i.test(f));
    if (physx) results.push(await runInstaller(path.join(redistDir, physx)));
  } catch { /* redist dir missing */ }

  // vcredist_x86.exe
  const vcredist = path.join(redistDir, 'vcredist_x86.exe');
  if (await exists(vcredist)) results.push(await runInstaller(vcredist));

  return results;
});

// ═════════════════════════════════════════════════════════════════════════════
// v1.4.0 STABILITY / DIAGNOSTICS / COMPATIBILITY
//
// Empirical refutation of audio-pool overflow as primary crash cause
// (see docs/RE_JOURNEY.md Postscript III & IV) pivoted us toward
// transition/state/media class bugs. This block adds launcher-side
// safety features that target THOSE actual crash causes:
//
//   * Crash Dump Helper      — HKCU LocalDumps reg keys (no admin)
//   * Media Compatibility    — detect LAV / K-Lite / codec pack remnants
//   * PhysX Legacy Check     — detect installed NVIDIA PhysX runtime
//   * Recommended Mode       — composite-toggle that flips safe defaults
//   * Diagnostic Export      — zip of launcher state for community triage
//
// All operations prefer HKCU over HKLM, never modify DP.exe binary, never
// uninstall third-party software, never run elevated unless explicitly
// requested.
// ═════════════════════════════════════════════════════════════════════════════

const { execFile, exec } = require('child_process');

function execAsync(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function execShellAsync(cmdline, options = {}) {
  return new Promise((resolve) => {
    exec(cmdline, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function regQuery(keyPath, valueName) {
  const args = ['QUERY', keyPath];
  if (valueName) args.push('/v', valueName);
  const { err, stdout } = await execAsync('reg.exe', args);
  if (err) return null;
  return stdout;
}

async function regAdd(keyPath, valueName, type, data) {
  const args = ['ADD', keyPath, '/v', valueName, '/t', type, '/d', String(data), '/f'];
  const { err, stderr } = await execAsync('reg.exe', args);
  return { ok: !err, error: err ? (stderr || err.message) : null };
}

async function regDelete(keyPath, valueName) {
  const args = ['DELETE', keyPath];
  if (valueName) args.push('/v', valueName);
  args.push('/f');
  const { err, stderr } = await execAsync('reg.exe', args);
  return { ok: !err, error: err ? (stderr || err.message) : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRASH DUMP HELPER (HKCU LocalDumps for DP.exe — no admin required)
// ─────────────────────────────────────────────────────────────────────────────
const CRASHDUMP_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\DP.exe';
const CRASHDUMP_FOLDER_DEFAULT = '%LOCALAPPDATA%\\CrashDumps';

ipcMain.handle('crashdump-status', async () => {
  const out = await regQuery(CRASHDUMP_KEY);
  if (!out) return { enabled: false };
  const folderMatch = out.match(/DumpFolder\s+REG_\w+\s+(.+)/i);
  const typeMatch   = out.match(/DumpType\s+REG_DWORD\s+0x(\w+)/i);
  const countMatch  = out.match(/DumpCount\s+REG_DWORD\s+0x(\w+)/i);
  return {
    enabled: true,
    folder: folderMatch ? folderMatch[1].trim() : null,
    type:   typeMatch   ? parseInt(typeMatch[1], 16) : null,
    count:  countMatch  ? parseInt(countMatch[1], 16) : null,
  };
});

ipcMain.handle('crashdump-enable', async (_event, { dumpFolder, dumpType, dumpCount } = {}) => {
  const folder = dumpFolder || CRASHDUMP_FOLDER_DEFAULT;
  const type   = dumpType   ?? 2;
  const count  = dumpCount  ?? 10;
  const steps = [];

  // Ensure folder exists (expand env var first)
  const expanded = folder.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
  try {
    await fs.promises.mkdir(expanded, { recursive: true });
    steps.push(`Created ${expanded}`);
  } catch { /* may already exist */ }

  const folderResult = await regAdd(CRASHDUMP_KEY, 'DumpFolder', 'REG_EXPAND_SZ', folder);
  if (!folderResult.ok) return { success: false, error: `DumpFolder: ${folderResult.error}` };
  steps.push('Set DumpFolder');

  const typeResult = await regAdd(CRASHDUMP_KEY, 'DumpType', 'REG_DWORD', String(type));
  if (!typeResult.ok) return { success: false, error: `DumpType: ${typeResult.error}` };
  steps.push(`Set DumpType=${type}`);

  const countResult = await regAdd(CRASHDUMP_KEY, 'DumpCount', 'REG_DWORD', String(count));
  if (!countResult.ok) return { success: false, error: `DumpCount: ${countResult.error}` };
  steps.push(`Set DumpCount=${count}`);

  return { success: true, steps, folder: expanded };
});

ipcMain.handle('crashdump-disable', async () => {
  const result = await regDelete(CRASHDUMP_KEY);
  return { success: result.ok, error: result.error };
});

ipcMain.handle('crashdump-open-folder', async () => {
  const expanded = (CRASHDUMP_FOLDER_DEFAULT).replace(/%([^%]+)%/g,
    (_, n) => process.env[n] || '');
  try {
    await fs.promises.mkdir(expanded, { recursive: true });
  } catch { /* may already exist */ }
  await shell.openPath(expanded);
  return { success: true, folder: expanded };
});

ipcMain.handle('crashdump-copy-instructions', async () => {
  const { clipboard } = require('electron');
  const tmpl = [
    "Deadly Premonition crash report",
    "================================",
    "",
    "Please send the following:",
    "",
    "1) Crash dump file (.dmp):",
    "   Location: %LOCALAPPDATA%\\CrashDumps\\DP.exe.*.dmp",
    "   Also check: C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\\",
    "                 C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue\\",
    "",
    "2) From Event Viewer (Windows Logs -> Application):",
    "   - Faulting module name",
    "   - Exception code",
    "   - Fault offset",
    "",
    "3) Context:",
    "   - Episode / Chapter:",
    "   - In-game location:",
    "   - Was there a cutscene starting or ending? yes / no",
    "   - Was there a loading screen or building transition? yes / no",
    "   - Was the crash reproducible? yes / no",
    "",
    "4) Your DP1 Launcher version (Settings -> About).",
    "",
    "Thank you — this helps make the launcher better for everyone.",
  ].join('\n');
  clipboard.writeText(tmpl);
  return { success: true, length: tmpl.length };
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIA COMPATIBILITY CHECK
//   Detects LAV Filters / K-Lite / MPC-HC / Shark007 in the uninstall registry
//   AND checks whether LAV*.ax modules exist on disk. Read-only — never modifies.
// ─────────────────────────────────────────────────────────────────────────────
const CODEC_PACK_PATTERNS = [
  { name: 'LAV Filters',  pattern: /LAV\s*Filters/i },
  { name: 'K-Lite Codec', pattern: /K[- ]?Lite/i },
  { name: 'MPC-HC',       pattern: /Media Player Classic|MPC-HC/i },
  { name: 'Shark007',     pattern: /Shark.?007/i },
  { name: 'CCCP',         pattern: /Combined Community Codec Pack|CCCP/i },
  { name: 'ffdshow',      pattern: /ffdshow/i },
];

async function scanUninstallKey(rootKey) {
  const out = await regQuery(rootKey);
  if (!out) return [];
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const subkeys = lines.filter(l => l.startsWith(rootKey));
  const found = [];
  for (const sub of subkeys) {
    const detail = await regQuery(sub, 'DisplayName');
    if (!detail) continue;
    const m = detail.match(/DisplayName\s+REG_\w+\s+(.+)/i);
    if (!m) continue;
    const displayName = m[1].trim();
    for (const cp of CODEC_PACK_PATTERNS) {
      if (cp.pattern.test(displayName)) {
        found.push({ name: cp.name, displayName, key: sub });
        break;
      }
    }
  }
  return found;
}

async function findLavModules() {
  const candidates = [
    'C:\\Program Files\\LAV Filters',
    'C:\\Program Files (x86)\\LAV Filters',
    'C:\\Program Files\\K-Lite Codec Pack\\Filters\\LAV',
    'C:\\Program Files (x86)\\K-Lite Codec Pack\\Filters\\LAV',
  ];
  const files = ['LAVVideo.ax', 'LAVSplitter.ax', 'LAVAudio.ax'];
  const out = [];
  for (const dir of candidates) {
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        await fs.promises.access(full);
        out.push(full);
      } catch { /* skip */ }
    }
  }
  // Also check default LAV registration via 64-bit
  const x64Files = [
    'C:\\Program Files\\LAV Filters\\x64\\LAVVideo.ax',
    'C:\\Program Files\\LAV Filters\\x64\\LAVSplitter.ax',
    'C:\\Program Files\\LAV Filters\\x64\\LAVAudio.ax',
  ];
  for (const f of x64Files) {
    try { await fs.promises.access(f); out.push(f); } catch { /* skip */ }
  }
  return out;
}

ipcMain.handle('media-check', async () => {
  const installed = [
    ...(await scanUninstallKey('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')),
    ...(await scanUninstallKey('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall')),
    ...(await scanUninstallKey('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')),
  ];
  // Dedup
  const seen = new Set();
  const dedupInstalled = installed.filter(i => {
    const key = `${i.name}::${i.displayName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const lavModules = await findLavModules();
  return {
    installed: dedupInstalled,
    lavModules,
    risky: dedupInstalled.length > 0 || lavModules.length > 0,
  };
});

ipcMain.handle('media-test-playback', async (_event, { gameDir } = {}) => {
  if (!gameDir) return { success: false, error: 'gameDir not provided' };
  // Look for a small .wmv file in updata/movie or updata_eu/_us/movie
  const movieDirs = [
    path.join(gameDir, 'updata', 'movie'),
    path.join(gameDir, 'updata_eu', '_us', 'movie'),
    path.join(gameDir, 'movie'),
  ];
  let chosen = null;
  for (const md of movieDirs) {
    try {
      const files = await fs.promises.readdir(md);
      const wmvs = files
        .filter(f => /\.wmv$/i.test(f))
        .map(f => ({ name: f, full: path.join(md, f) }));
      if (!wmvs.length) continue;
      // Pick smallest .wmv to minimise test time
      const sizes = await Promise.all(wmvs.map(async w => {
        try { return { ...w, size: (await fs.promises.stat(w.full)).size }; }
        catch { return { ...w, size: Infinity }; }
      }));
      sizes.sort((a, b) => a.size - b.size);
      chosen = sizes[0];
      break;
    } catch { /* dir missing */ }
  }
  if (!chosen) return { success: false, error: 'No .wmv files found in game directory' };

  try {
    await shell.openPath(chosen.full);
    return { success: true, file: chosen.name, sizeKB: Math.round(chosen.size / 1024) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY PHYSX CHECK
//   Reads HKLM\SOFTWARE\AGEIA Technologies (legacy installer location).
//   Read-only.
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('physx-check', async () => {
  const result = { installed: false, version: null, location: null };
  // AGEIA PhysX legacy registry (modern PhysX uses different keys)
  const ageiaKey = 'HKLM\\SOFTWARE\\WOW6432Node\\AGEIA Technologies';
  const ageiaKey32 = 'HKLM\\SOFTWARE\\AGEIA Technologies';
  for (const key of [ageiaKey, ageiaKey32]) {
    const out = await regQuery(key);
    if (out) {
      result.installed = true;
      const versionMatch = out.match(/(?:Version|enginePath)\s+REG_\w+\s+(.+)/i);
      if (versionMatch) {
        result.version = versionMatch[1].trim();
      }
      const pathMatch = out.match(/enginePath\s+REG_\w+\s+(.+)/i);
      if (pathMatch) result.location = pathMatch[1].trim();
      break;
    }
  }
  // Also check installed PhysX as a program
  const ageiaInstalls = await scanUninstallKey('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
  // (reuse scanUninstallKey but match PhysX pattern)
  // Easier: re-run with PhysX-specific pattern
  for (const root of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    const out = await regQuery(root);
    if (!out) continue;
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const subkeys = lines.filter(l => l.startsWith(root));
    for (const sub of subkeys) {
      const detail = await regQuery(sub, 'DisplayName');
      const ver    = await regQuery(sub, 'DisplayVersion');
      if (detail && /PhysX/i.test(detail)) {
        result.installed = true;
        if (ver) {
          const vm = ver.match(/DisplayVersion\s+REG_\w+\s+(.+)/i);
          if (vm) result.version = vm[1].trim();
        }
        break;
      }
    }
    if (result.installed && result.version) break;
  }
  return result;
});

// ─────────────────────────────────────────────────────────────────────────────
// RECOMMENDED STABILITY MODE
//   Composite toggle that flips safe defaults:
//     * Save backup worker → ON
//     * Session timer reminder → ON
//     * FPS cap (dxvk.conf 60) → ON
//     * Crash dump collection → ON (HKCU LocalDumps)
//     * Codec fix (watcher) → started on next game launch
//
//   On apply, saves a snapshot of previous state so revert can restore it.
//   Stores snapshot in app.getPath('userData')/stability-mode.snapshot.json
// ─────────────────────────────────────────────────────────────────────────────
function stabilitySnapshotPath() {
  return path.join(app.getPath('userData'), 'stability-mode.snapshot.json');
}

ipcMain.handle('stability-mode-status', async (_event, { gameDir } = {}) => {
  const status = {
    enabled: false,
    components: {
      crashDump:    false,
      fpsCapDxvk:   false,
      savesBackup:  false,
      dpfixBorderless: false,
    },
  };
  try {
    const snap = await fs.promises.readFile(stabilitySnapshotPath(), 'utf8');
    const parsed = JSON.parse(snap);
    status.enabled = !!parsed.applied;
    status.appliedAt = parsed.appliedAt;
  } catch { /* not applied */ }
  // Component checks (best-effort)
  const dump = await regQuery(CRASHDUMP_KEY);
  status.components.crashDump = !!dump;
  if (gameDir) {
    const dxvkConf = path.join(gameDir, 'dxvk.conf');
    try {
      const conf = await fs.promises.readFile(dxvkConf, 'utf8');
      status.components.fpsCapDxvk = /dxvk\.maxFrameRate\s*=\s*60/.test(conf);
    } catch { /* no conf */ }
    const dpfixIni = path.join(gameDir, 'DPfix.ini');
    try {
      const ini = await fs.promises.readFile(dpfixIni, 'utf8');
      status.components.dpfixBorderless =
        /forceWindowed\s*=\s*1/i.test(ini) &&
        /borderlessFullscreen\s*=\s*1/i.test(ini);
    } catch { /* no DPfix.ini */ }
  }
  return status;
});

async function readIniSimple(filepath) {
  try {
    const txt = await fs.promises.readFile(filepath, 'utf8');
    return txt;
  } catch { return null; }
}

async function setIniKeys(filepath, kvs) {
  // Read current content, modify lines, write back. Preserves order/comments.
  let txt = (await readIniSimple(filepath)) || '';
  for (const [k, v] of Object.entries(kvs)) {
    const re = new RegExp(`^([ \\t]*${k}[ \\t]*=).*$`, 'mi');
    if (re.test(txt)) {
      txt = txt.replace(re, `$1 ${v}`);
    } else {
      txt += (txt.endsWith('\n') ? '' : '\n') + `${k} = ${v}\n`;
    }
  }
  await fs.promises.writeFile(filepath, txt, 'utf8');
}

ipcMain.handle('stability-mode-apply', async (_event, { gameDir } = {}) => {
  if (!gameDir) return { success: false, error: 'gameDir not provided' };
  const steps = [];
  const snapshot = { appliedAt: new Date().toISOString(), applied: true, prior: {} };

  // 1. Enable crash dump collection
  const dumpPrior = await regQuery(CRASHDUMP_KEY);
  snapshot.prior.crashDumpEnabled = !!dumpPrior;
  try {
    await regAdd(CRASHDUMP_KEY, 'DumpFolder', 'REG_EXPAND_SZ', CRASHDUMP_FOLDER_DEFAULT);
    await regAdd(CRASHDUMP_KEY, 'DumpType',   'REG_DWORD', '2');
    await regAdd(CRASHDUMP_KEY, 'DumpCount',  'REG_DWORD', '10');
    const expanded = CRASHDUMP_FOLDER_DEFAULT.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
    await fs.promises.mkdir(expanded, { recursive: true });
    steps.push('Crash dump collection enabled');
  } catch (e) {
    steps.push(`Crash dump skip: ${e.message}`);
  }

  // 2. Set DXVK FPS cap = 60 (write/update dxvk.conf)
  const dxvkConf = path.join(gameDir, 'dxvk.conf');
  try {
    const priorConf = await readIniSimple(dxvkConf);
    snapshot.prior.dxvkConf = priorConf;
    await setIniKeys(dxvkConf, { 'dxvk.maxFrameRate': '60' });
    steps.push('DXVK FPS cap = 60');
  } catch (e) {
    steps.push(`DXVK conf skip: ${e.message}`);
  }

  // 3. Update DPfix.ini for borderless/windowed-safe defaults (if DPfix.ini exists)
  const dpfixIni = path.join(gameDir, 'DPfix.ini');
  try {
    if (await exists(dpfixIni)) {
      // Backup first
      const bak = `${dpfixIni}.stability-mode.bak`;
      try {
        await fs.promises.copyFile(dpfixIni, bak);
        steps.push(`DPfix.ini backup → ${path.basename(bak)}`);
      } catch { /* ignore */ }
      snapshot.prior.dpfixIni = await readIniSimple(dpfixIni);
      // Common safer defaults for transition crashes
      await setIniKeys(dpfixIni, {
        forceWindowed: '1',
        borderlessFullscreen: '1',
      });
      steps.push('DPfix forceWindowed=1, borderlessFullscreen=1');
    }
  } catch (e) {
    steps.push(`DPfix.ini skip: ${e.message}`);
  }

  // 4. Save backup (autosave worker) — flip preference (renderer side reads this on next launcher start)
  snapshot.prior.savesAutoBackup = global.__savesAutoBackupWasOn || null;
  // Note: we don't start the worker here; renderer flips the toggle.
  steps.push('Save backup recommended (toggle in Saves tab if not yet on)');

  // Persist snapshot for revert
  await fs.promises.writeFile(stabilitySnapshotPath(), JSON.stringify(snapshot, null, 2));

  return { success: true, steps };
});

ipcMain.handle('stability-mode-revert', async (_event, { gameDir } = {}) => {
  const steps = [];
  let snap;
  try {
    snap = JSON.parse(await fs.promises.readFile(stabilitySnapshotPath(), 'utf8'));
  } catch {
    return { success: false, error: 'No applied snapshot found — nothing to revert.' };
  }

  // Restore crash dump (only if it wasn't already on before)
  if (!snap.prior.crashDumpEnabled) {
    await regDelete(CRASHDUMP_KEY);
    steps.push('Crash dump collection disabled (was off before)');
  } else {
    steps.push('Crash dump kept (was on before)');
  }

  // Restore dxvk.conf
  if (gameDir) {
    const dxvkConf = path.join(gameDir, 'dxvk.conf');
    if (typeof snap.prior.dxvkConf === 'string') {
      try {
        await fs.promises.writeFile(dxvkConf, snap.prior.dxvkConf, 'utf8');
        steps.push('dxvk.conf restored');
      } catch { /* ignore */ }
    } else if (snap.prior.dxvkConf === null) {
      try { await fs.promises.unlink(dxvkConf); steps.push('dxvk.conf removed (was absent before)'); } catch {}
    }
    // Restore DPfix.ini
    const dpfixIni = path.join(gameDir, 'DPfix.ini');
    if (typeof snap.prior.dpfixIni === 'string') {
      try {
        await fs.promises.writeFile(dpfixIni, snap.prior.dpfixIni, 'utf8');
        steps.push('DPfix.ini restored');
      } catch { /* ignore */ }
    }
  }

  // Remove snapshot
  try { await fs.promises.unlink(stabilitySnapshotPath()); } catch {}

  return { success: true, steps };
});

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTIC PACKAGE EXPORT
//   Builds a folder under userData with launcher state + check results +
//   selected logs. User picks save location, we zip into single .zip.
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('diagnostic-export', async (_event, { gameDir, includeSaves = false, includeDumps = false } = {}) => {
  if (!gameDir) return { success: false, error: 'gameDir not provided' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const stagingRoot = path.join(app.getPath('userData'), 'diagnostic-export', stamp);
  try {
    await fs.promises.mkdir(stagingRoot, { recursive: true });
  } catch (e) {
    return { success: false, error: `Staging dir: ${e.message}` };
  }

  const report = {
    timestamp: new Date().toISOString(),
    launcher: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
    },
    system: {
      windows: os.release(),
      cpus: os.cpus().length,
      totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    },
    gameDir,
    checks: {},
  };

  // 1. Game files present
  const checkFile = async (p) => {
    try { const s = await fs.promises.stat(path.join(gameDir, p)); return { exists: true, size: s.size }; }
    catch { return { exists: false }; }
  };
  report.checks.dpExe       = await checkFile('DP.exe');
  report.checks.dpExeBackup = await checkFile('DP.exe.Backup');
  report.checks.d3d9        = await checkFile('d3d9.dll');
  report.checks.dpfixIni    = await checkFile('DPfix.ini');
  report.checks.dpfixLog    = await checkFile('DPfix.log');
  report.checks.dxvkConf    = await checkFile('dxvk.conf');

  // 2. LAA flag (read PE header characteristics)
  try {
    const dpPath = path.join(gameDir, 'DP.exe');
    const fd = await fs.promises.open(dpPath, 'r');
    try {
      const headBuf = Buffer.alloc(0x200);
      await fd.read(headBuf, 0, 0x200, 0);
      const eLfanew = headBuf.readUInt32LE(0x3C);
      const charsBuf = Buffer.alloc(2);
      await fd.read(charsBuf, 0, 2, eLfanew + 4 + 18);
      const chars = charsBuf.readUInt16LE(0);
      report.checks.laaApplied = (chars & 0x0020) !== 0;
      report.checks.peCharacteristics = `0x${chars.toString(16)}`;
    } finally {
      await fd.close();
    }
  } catch (e) {
    report.checks.laaApplied = null;
    report.checks.peCharacteristicsError = e.message;
  }

  // 3. Media compatibility
  try {
    // Reuse media-check logic via direct call
    const handler = ipcMain._invokeHandlers?.get?.('media-check');
    if (handler) report.checks.media = await handler();
  } catch { /* ignore */ }

  // 4. PhysX
  try {
    const handler = ipcMain._invokeHandlers?.get?.('physx-check');
    if (handler) report.checks.physx = await handler();
  } catch { /* ignore */ }

  // 5. DXVK status
  report.checks.dxvkAppliedSystemDll = false;
  try {
    await fs.promises.access('C:\\Windows\\SysWOW64\\d9vk.dll');
    report.checks.dxvkAppliedSystemDll = true;
  } catch { /* not applied */ }

  // 6. Crash dump status
  const dumpOut = await regQuery(CRASHDUMP_KEY);
  report.checks.crashDumpEnabled = !!dumpOut;

  // Write report
  await fs.promises.writeFile(
    path.join(stagingRoot, 'report.json'),
    JSON.stringify(report, null, 2)
  );

  // 7. Copy log files (if present)
  const logFiles = ['DPfix.log', 'dp_d3d9.log', 'DPLauncher_d3d9.log', 'update.log'];
  for (const lf of logFiles) {
    try {
      await fs.promises.copyFile(
        path.join(gameDir, lf),
        path.join(stagingRoot, lf)
      );
    } catch { /* skip */ }
  }
  // Copy DPfix.ini for reference
  try {
    await fs.promises.copyFile(
      path.join(gameDir, 'DPfix.ini'),
      path.join(stagingRoot, 'DPfix.ini.snapshot')
    );
  } catch { /* skip */ }
  // Copy dxvk.conf if present
  try {
    await fs.promises.copyFile(
      path.join(gameDir, 'dxvk.conf'),
      path.join(stagingRoot, 'dxvk.conf.snapshot')
    );
  } catch { /* skip */ }

  // Ask user for output location
  const result = await dialog.showSaveDialog({
    title: 'Save Diagnostic Package',
    defaultPath: `DP1-Diagnostic-${stamp}.zip`,
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) {
    return { success: false, error: 'User cancelled' };
  }

  // Zip via PowerShell Compress-Archive (built into Windows)
  const ps = `Compress-Archive -Path "${stagingRoot}\\*" -DestinationPath "${result.filePath}" -Force`;
  const { err, stderr } = await execAsync('powershell.exe', ['-NoProfile', '-Command', ps]);
  if (err) return { success: false, error: `zip: ${stderr || err.message}` };

  // Cleanup staging
  try { await fs.promises.rm(stagingRoot, { recursive: true, force: true }); } catch {}

  return { success: true, outputPath: result.filePath, size: (await fs.promises.stat(result.filePath)).size };
});

// ─────────────────────────────────────────────────────────────────────────────
// XIDI INFO (informational helper — no auto-install)
// ─────────────────────────────────────────────────────────────────────────────
ipcMain.handle('xidi-open-page', async () => {
  await shell.openExternal('https://github.com/samuelgr/Xidi');
  return { success: true };
});

ipcMain.handle('xidi-check-installed', async (_event, { gameDir } = {}) => {
  if (!gameDir) return { installed: false };
  const candidates = ['winmm.dll', 'dinput.dll', 'dinput8.dll', 'Xidi.ini'];
  const found = [];
  for (const f of candidates) {
    try {
      const full = path.join(gameDir, f);
      const stat = await fs.promises.stat(full);
      // Skip system winmm signature — Xidi's winmm.dll is small (~100-500KB)
      // System winmm.dll is also small, so we just report presence.
      found.push({ name: f, sizeKB: Math.round(stat.size / 1024) });
    } catch { /* skip */ }
  }
  return { installed: found.some(f => f.name === 'Xidi.ini'), files: found };
});

// End of v1.4.0 stability/diagnostics block

// ═════════════════════════════════════════════════════════════════════════════
// FIRST-RUN PRESET PICKER (v1.4 wizard redesign)
// Replaces individual 4GB/DXVK yes-no buttons with a single preset choice:
//   * 'dpfix-dxvk'  → DPfix + DXVK chain (optimal, current default)
//   * 'dxvk-only'   → DXVK without DPfix wrapper (fast load)
//   * 'dpfix-only'  → DPfix with native System32 d3d9.dll (no Vulkan)
// 4GB Patch is offered separately, auto-recommended when host RAM > 4GB.
// ═════════════════════════════════════════════════════════════════════════════

ipcMain.handle('system-info', async () => {
  return {
    totalMemoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    totalMemoryBytes: os.totalmem(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model || 'unknown',
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
  };
});

ipcMain.handle('apply-preset', async (_event, { gameDir, preset, with4gb } = {}) => {
  if (!gameDir) return { success: false, error: 'gameDir not provided' };
  if (!preset)  return { success: false, error: 'preset not provided' };

  const steps = [];
  const exePath = path.join(gameDir, 'DP.exe');

  // 1. Apply 4GB patch if requested
  if (with4gb) {
    try {
      const fd = await fs.promises.open(exePath, 'r');
      const head = Buffer.alloc(0x200);
      await fd.read(head, 0, 0x200, 0);
      const eLfanew = head.readUInt32LE(0x3C);
      const charsBuf = Buffer.alloc(2);
      await fd.read(charsBuf, 0, 2, eLfanew + 4 + 18);
      const chars = charsBuf.readUInt16LE(0);
      await fd.close();
      if (chars & 0x0020) {
        steps.push('4GB Patch already applied');
      } else {
        const patchExe = path.join(gameDir, '4gb_patch.exe');
        const localPatch = await exists(patchExe) ? patchExe :
                           path.join(process.resourcesPath || '', '4gb_patch.exe');
        if (await exists(localPatch)) {
          const { err, stderr } = await execAsync(localPatch, [exePath]);
          if (err) {
            steps.push(`4GB Patch failed: ${stderr || err.message}`);
          } else {
            const moved = await migrateNTCore4gbBackup(exePath).catch(() => null);
            steps.push(moved
              ? `4GB Patch applied ✓ (backup → exe_backup/${path.basename(moved)})`
              : '4GB Patch applied ✓');
          }
        } else {
          steps.push('4GB Patch skipped (patcher not found in game or resources)');
        }
      }
    } catch (e) {
      steps.push(`4GB Patch error: ${e.message}`);
    }
  }

  // 2. Apply preset
  const d3d9Path  = path.join(gameDir, 'd3d9.dll');
  const d9vkSys   = 'C:\\Windows\\SysWOW64\\d9vk.dll';

  switch (preset) {
    case 'dpfix-dxvk': {
      // DPfix wrapper + DXVK chain (current full setup). Equivalent of
      // the existing apply-dxvk-auto path.
      // Pre-flight: this preset writes to C:\Windows\SysWOW64, which needs admin.
      // Bail cleanly with an actionable error instead of letting copyFile EPERM.
      if (!(await isAdmin())) {
        return {
          success: false,
          error: 'NEEDS_ADMIN',
          needsAdmin: true,
          alternative: 'dxvk-only',
          steps,
        };
      }
      const src = await findDxvkSourceDll(gameDir);
      if (!src) { steps.push('DXVK source missing — install DXVK first'); break; }
      try {
        await fs.promises.copyFile(src, d9vkSys);
        steps.push('Copied DXVK → SysWOW64\\d9vk.dll');
      } catch (e) {
        steps.push(`DXVK system copy failed: ${e.message}`);
        return {
          success: false,
          error: 'NEEDS_ADMIN',
          needsAdmin: true,
          alternative: 'dxvk-only',
          steps,
        };
      }
      // Patch in-place game d3d9.dll to forward into d9vk.dll
      try {
        if (await exists(d3d9Path)) {
          // Backup the DPfix d3d9.dll (idempotent across launcher versions)
          await makeBackup(d3d9Path, BACKUP_LABELS.d3d9DpfixOnly);
          // Hex-patch "d3d9.dll" → "d9vk.dll" (8 chars each, preserves length)
          const buf = await fs.promises.readFile(d3d9Path);
          const needle = Buffer.from('d3d9.dll', 'ascii');
          const replace = Buffer.from('d9vk.dll', 'ascii');
          let count = 0;
          for (let i = 0; i + needle.length <= buf.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
              if (buf[i + j] !== needle[j]) { match = false; break; }
            }
            if (match) { replace.copy(buf, i); count++; i += needle.length - 1; }
          }
          await fs.promises.writeFile(d3d9Path, buf);
          steps.push(`Patched ${count} occurrence(s) of 'd3d9.dll' → 'd9vk.dll'`);
        } else {
          steps.push('Game d3d9.dll not found — install DPfix first');
        }
      } catch (e) {
        steps.push(`Game d3d9.dll patch failed: ${e.message}`);
      }
      break;
    }
    case 'dxvk-only': {
      // DXVK without DPfix wrapper: replace game d3d9.dll directly with DXVK's d3d9.dll
      const src = await findDxvkSourceDll(gameDir);
      if (!src) { steps.push('DXVK source missing'); break; }
      try {
        if (await exists(d3d9Path)) {
          await makeBackup(d3d9Path, BACKUP_LABELS.d3d9DpfixOnly);
        }
        await fs.promises.copyFile(src, d3d9Path);
        steps.push('Installed DXVK d3d9.dll directly (no DPfix wrapper)');
      } catch (e) {
        steps.push(`DXVK-only install failed: ${e.message}`);
      }
      // Remove SysWOW64 d9vk.dll if it was set (cleanup from previous mode)
      try {
        await fs.promises.unlink(d9vkSys);
        steps.push('Removed SysWOW64\\d9vk.dll (cleanup)');
      } catch { /* not present */ }
      break;
    }
    case 'dpfix-only': {
      // DPfix only — restore d3d9.dll from exe_backup (raw DPfix wrapper without DXVK chain).
      // If the backup is missing, leave d3d9.dll as-is but un-patch the 'd9vk.dll' string back.
      const d3d9BakResolved = await resolveBackup(d3d9Path, BACKUP_LABELS.d3d9DpfixOnly);
      try {
        if (d3d9BakResolved) {
          await fs.promises.copyFile(d3d9BakResolved, d3d9Path);
          steps.push(`Restored DPfix d3d9.dll from ${path.relative(gameDir, d3d9BakResolved)}`);
        } else if (await exists(d3d9Path)) {
          // hex-undo d9vk.dll → d3d9.dll
          const buf = await fs.promises.readFile(d3d9Path);
          const needle = Buffer.from('d9vk.dll', 'ascii');
          const replace = Buffer.from('d3d9.dll', 'ascii');
          let count = 0;
          for (let i = 0; i + needle.length <= buf.length; i++) {
            let match = true;
            for (let j = 0; j < needle.length; j++) {
              if (buf[i + j] !== needle[j]) { match = false; break; }
            }
            if (match) { replace.copy(buf, i); count++; i += needle.length - 1; }
          }
          if (count > 0) {
            await fs.promises.writeFile(d3d9Path, buf);
            steps.push(`Reverted ${count} hex-patch(es) inside game d3d9.dll`);
          } else {
            steps.push('Game d3d9.dll already DPfix-only');
          }
        } else {
          steps.push('Game d3d9.dll not found — install DPfix first');
        }
      } catch (e) {
        steps.push(`DPfix-only setup failed: ${e.message}`);
      }
      // Remove SysWOW64\d9vk.dll
      try {
        await fs.promises.unlink(d9vkSys);
        steps.push('Removed SysWOW64\\d9vk.dll');
      } catch { /* not present */ }
      break;
    }
    default:
      return { success: false, error: `Unknown preset: ${preset}` };
  }

  return { success: true, preset, steps };
});

// (findDxvkSourceDll is already defined earlier in this file at ~line 1860)

// ─────────────────────────────────────────────────────────────────────────────
// EXPERIMENTAL: NaN Hang Guard (v1.5.0)
//   Pattern-scan + 2-byte runtime fix to DP.exe for the known infinite-loop
//   assert at VA 0x00409EA6. See workers/nan_guard.js + docs/NAN_HANG_GUARD.md.
// ─────────────────────────────────────────────────────────────────────────────
// nan_guard is now loaded inside workers/heavy-tasks.js (worker thread).
// Main process talks to it via runHeavyTask('nan-guard:*', { exePath }).

function dpExePath(gameDir) {
  if (!gameDir) return null;
  return path.join(gameDir, 'DP.exe');
}

ipcMain.handle('nan-guard-status', async (_event, { gameDir } = {}) => {
  const exePath = dpExePath(gameDir);
  if (!exePath) return { ok: false, status: 'no-game' };
  return await runHeavyTask('nan-guard:analyze', { exePath });
});

ipcMain.handle('nan-guard-apply', async (_event, { gameDir } = {}) => {
  const exePath = dpExePath(gameDir);
  if (!exePath) return { ok: false, status: 'no-game' };
  // Refuse if game is currently running (we cannot safely modify a running binary).
  const running = await new Promise((resolve) => {
    require('child_process').exec(
      'tasklist /FI "IMAGENAME eq DP.exe" /FO CSV /NH',
      (err, stdout) => resolve(!err && /DP\.exe/i.test(stdout || ''))
    );
  });
  if (running) {
    return { ok: false, status: 'game-running', error: 'DP.exe is currently running. Close the game first.' };
  }
  return await runHeavyTask('nan-guard:apply', { exePath });
});

ipcMain.handle('nan-guard-revert', async (_event, { gameDir } = {}) => {
  const exePath = dpExePath(gameDir);
  if (!exePath) return { ok: false, status: 'no-game' };
  const running = await new Promise((resolve) => {
    require('child_process').exec(
      'tasklist /FI "IMAGENAME eq DP.exe" /FO CSV /NH',
      (err, stdout) => resolve(!err && /DP\.exe/i.test(stdout || ''))
    );
  });
  if (running) {
    return { ok: false, status: 'game-running', error: 'DP.exe is currently running. Close the game first.' };
  }
  return await runHeavyTask('nan-guard:revert', { exePath });
});

// GPU info (used by Stability tab to surface DXVK recommendation for legacy
// AMD/Intel drivers that deadlock on D3D9 — see Tree Fan Ch.3 dump #3).
// `wmic` is deprecated and missing on newer Win11 builds; use CIM via PowerShell.
ipcMain.handle('gpu-info', async () => {
  return await new Promise((resolve) => {
    const psCmd =
      'Get-CimInstance Win32_VideoController | ' +
      'Select-Object Name,AdapterCompatibility,DriverVersion | ' +
      'ConvertTo-Json -Compress';
    require('child_process').execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psCmd],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) { resolve({ ok: false, gpus: [], error: err?.message || 'no stdout' }); return; }
        let parsed;
        try { parsed = JSON.parse(stdout.trim()); }
        catch (e) { resolve({ ok: false, gpus: [], error: 'parse: ' + e.message }); return; }
        const gpus = (Array.isArray(parsed) ? parsed : [parsed]).filter(g => g && g.Name);
        // Flag legacy AMD/Intel drivers known to deadlock on DP.exe's D3D9 path.
        const legacy = gpus.filter(g => {
          const name = (g.Name || '').toLowerCase();
          const vendor = (g.AdapterCompatibility || '').toLowerCase();
          // Northern Islands / older HD-series AMD GPUs route via AMDXN32.DLL,
          // which has the known D3D9 spinlock seen in Tree Fan's dump #3.
          if (vendor.includes('amd') || vendor.includes('ati') || name.includes('radeon')) {
            return /\b(hd ?[2-7]\d{3}|r[5-9] ?[2-3]\d{2}|hd ?\d{4})\b/.test(name);
          }
          if (vendor.includes('intel') || name.includes('intel')) {
            return /\b(hd graphics|gma|iris|uhd graphics 6\d{2})\b/.test(name);
          }
          return false;
        });
        resolve({ ok: true, gpus, legacy });
      }
    );
  });
});
