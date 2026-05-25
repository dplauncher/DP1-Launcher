'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Window controls ──────────────────────────
  minimizeWindow:   () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow:   () => ipcRenderer.invoke('window-maximize'),
  closeWindow:      () => ipcRenderer.invoke('window-close'),

  // ── Steam launch ─────────────────────────────
  launchSteam:      (appId) => ipcRenderer.invoke('launch-steam', appId),

  // ── INI file operations ───────────────────────
  loadIni:          (filePath)          => ipcRenderer.invoke('load-ini',   filePath),
  saveIni:          (payload)           => ipcRenderer.invoke('save-ini',   payload),
  findIni:          ()                  => ipcRenderer.invoke('find-ini'),
  browseIni:        ()                  => ipcRenderer.invoke('browse-ini'),

  // ── Game operations ───────────────────────────
  browseExe:        ()                  => ipcRenderer.invoke('browse-exe'),
  launchGame:       (exePath)           => ipcRenderer.invoke('launch-game', exePath),

  // ── First-launch setup wizard ─────────────────
  pickGameDir:      ()                  => ipcRenderer.invoke('pick-game-dir'),
  autodetectGame:   ()                  => ipcRenderer.invoke('autodetect-game'),
  setupInstallAll:  (gameDir)           => ipcRenderer.invoke('setup-install-all', { gameDir }),
  onSetupProgress:  (cb)                => ipcRenderer.on('setup-progress', (_e, msg) => cb(msg)),
  apply4gbAuto:     (gameDir, targetExe)=> ipcRenderer.invoke('apply-4gb-auto',  { gameDir, targetExe }),
  applyDxvkAuto:    (gameDir)           => ipcRenderer.invoke('apply-dxvk-auto', { gameDir }),
  revertDxvkAuto:   (gameDir)           => ipcRenderer.invoke('revert-dxvk-auto', { gameDir }),
  checkDxvkApplied: (gameDir)           => ipcRenderer.invoke('check-dxvk-applied', { gameDir }),
  checkSkipIntro:   (exePath)           => ipcRenderer.invoke('check-skip-intro', { exePath }),
  applySkipIntro:   (exePath, enable)   => ipcRenderer.invoke('apply-skip-intro', { exePath, enable }),
  checkFpsCap:      (gameDir)           => ipcRenderer.invoke('check-fps-cap',   { gameDir }),
  applyFpsCap:      (gameDir, enable)   => ipcRenderer.invoke('apply-fps-cap',   { gameDir, enable }),
  openGpuSettings:  (vendor)            => ipcRenderer.invoke('open-gpu-settings', { vendor }),
  dxvkCacheInfo:    (gameDir)           => ipcRenderer.invoke('dxvk-cache-info', { gameDir }),
  dxvkCacheClean:   (gameDir)           => ipcRenderer.invoke('dxvk-cache-clean', { gameDir }),
  checkCodecFix:    ()                  => ipcRenderer.invoke('check-codec-fix'),
  startCodecFix:    (processName)       => ipcRenderer.invoke('start-codec-fix', { processName }),
  stopCodecFix:     ()                  => ipcRenderer.invoke('stop-codec-fix'),
  startCursorHide:  (processName)       => ipcRenderer.invoke('start-cursor-hide', { processName }),
  stopCursorHide:   ()                  => ipcRenderer.invoke('stop-cursor-hide'),
  checkCaptureCursor:(gameDir)          => ipcRenderer.invoke('check-capture-cursor', { gameDir }),
  applyCaptureCursor:(gameDir, enable)  => ipcRenderer.invoke('apply-capture-cursor', { gameDir, enable }),
  onSessionWarning:  (cb)               => ipcRenderer.on('session-warning', (_e, data) => cb(data)),
  setSteamOverlay:  (appId, enabled)    => ipcRenderer.invoke('set-steam-overlay', { appId, enabled }),

  // ── Persistent settings ───────────────────────
  settingsRead:     ()                  => ipcRenderer.invoke('settings-read'),
  settingsWrite:    (data)              => ipcRenderer.invoke('settings-write', data),
  settingsResetAll: ()                  => ipcRenderer.invoke('settings-reset-all'),
  relaunchApp:     ()                  => ipcRenderer.invoke('relaunch-app'),

  // ── Misc ─────────────────────────────────────
  quitApp:          ()                  => ipcRenderer.invoke('quit-app'),
  hideToTray:       (lang)              => ipcRenderer.invoke('hide-to-tray', lang),
  openExternal:     (url)               => ipcRenderer.invoke('open-external', url),
  getLocale:        ()                  => ipcRenderer.invoke('get-locale'),
  getTranslations:  ()                  => ipcRenderer.invoke('get-translations'),
  checkUpdate:      ()                  => ipcRenderer.invoke('check-update'),
  applyUpdate:      ()                  => ipcRenderer.invoke('apply-update'),
  onUpdateProgress: (cb)                => ipcRenderer.on('update-progress', (_e, msg) => cb(msg)),
  getAppVersion:    ()                  => ipcRenderer.invoke('get-version'),

  // ── Activity log ─────────────────────────────
  activityRead:     ()                  => ipcRenderer.invoke('activity-read'),
  activityLog:      (entry)             => ipcRenderer.invoke('activity-log', entry),
  activityClear:    ()                  => ipcRenderer.invoke('activity-clear'),

  // ── News feed (GitHub raw) ───────────────────
  fetchNews:        ()                  => ipcRenderer.invoke('fetch-news'),

  // ── Admin & elevation ─────────────────────
  isAdmin:          ()                  => ipcRenderer.invoke('is-admin'),
  relaunchAsAdmin:  ()                  => ipcRenderer.invoke('relaunch-as-admin'),

  // ── Compatibility mode ────────────────────
  getCompatStatus:  (exePath)           => ipcRenderer.invoke('get-compat-status', exePath),
  setCompat:        (exePath, mode)     => ipcRenderer.invoke('set-compat',         exePath, mode),
  removeCompat:     (exePath)           => ipcRenderer.invoke('remove-compat',      exePath),

  // ── 4GB patch ────────────────────────────
  run4gbPatch:      (targetExe)         => ipcRenderer.invoke('run-4gb-patch',      targetExe),

  // ── DXVK ─────────────────────────────────
  checkDxvk:        ()                  => ipcRenderer.invoke('check-dxvk'),
  getBundledDxvk:   ()                  => ipcRenderer.invoke('get-bundled-dxvk'),
  installDxvk:      (sourcePath)        => ipcRenderer.invoke('install-dxvk',       sourcePath),
  uninstallDxvk:    ()                  => ipcRenderer.invoke('uninstall-dxvk'),
  browseDll:        ()                  => ipcRenderer.invoke('browse-dll'),

  // ── Redist installer ─────────────────────
  installRedist:    (gameDir)           => ipcRenderer.invoke('install-redist', gameDir),

  // ── Autosave & Save management ─────────
  autosaveStart:    (gameDir, interval) => ipcRenderer.invoke('autosave-start', gameDir, interval),
  autosaveStop:     ()                  => ipcRenderer.invoke('autosave-stop'),
  onAutosaveEvent:  (cb)                => ipcRenderer.on('autosave-event', (_e, msg) => cb(msg)),
  savesList:        (gameDir)           => ipcRenderer.invoke('saves-list',     gameDir),
  savesRestore:     (gameDir, id)       => ipcRenderer.invoke('saves-restore',  gameDir, id),
  savesDelete:      (gameDir, id)       => ipcRenderer.invoke('saves-delete',   gameDir, id),
  savesSetDesc:     (gameDir, id, desc) => ipcRenderer.invoke('saves-set-desc', gameDir, id, desc),

  // ── v1.4.0 Stability / Diagnostics / Compatibility ─────────────
  crashdumpStatus:           ()                 => ipcRenderer.invoke('crashdump-status'),
  crashdumpEnable:           (opts)             => ipcRenderer.invoke('crashdump-enable', opts || {}),
  crashdumpDisable:          ()                 => ipcRenderer.invoke('crashdump-disable'),
  crashdumpOpenFolder:       ()                 => ipcRenderer.invoke('crashdump-open-folder'),
  crashdumpCopyInstructions: ()                 => ipcRenderer.invoke('crashdump-copy-instructions'),
  mediaCheck:                ()                 => ipcRenderer.invoke('media-check'),
  mediaTestPlayback:         (gameDir)          => ipcRenderer.invoke('media-test-playback', { gameDir }),
  physxCheck:                ()                 => ipcRenderer.invoke('physx-check'),
  stabilityModeStatus:       (gameDir)          => ipcRenderer.invoke('stability-mode-status', { gameDir }),
  stabilityModeApply:        (gameDir)          => ipcRenderer.invoke('stability-mode-apply',  { gameDir }),
  stabilityModeRevert:       (gameDir)          => ipcRenderer.invoke('stability-mode-revert', { gameDir }),
  diagnosticExport:          (gameDir, opts)    => ipcRenderer.invoke('diagnostic-export', { gameDir, ...(opts || {}) }),
  xidiOpenPage:              ()                 => ipcRenderer.invoke('xidi-open-page'),
  xidiCheckInstalled:        (gameDir)          => ipcRenderer.invoke('xidi-check-installed', { gameDir }),

  // First-run preset picker (v1.4)
  systemInfo:                ()                 => ipcRenderer.invoke('system-info'),
  applyPreset:               (gameDir, preset, with4gb) =>
                              ipcRenderer.invoke('apply-preset', { gameDir, preset, with4gb }),
});
