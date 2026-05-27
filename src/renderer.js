'use strict';
/**
 * renderer.js — Renderer logic for the redesigned launcher.
 *
 * Component-oriented organisation (each `setup*()` function wires one chunk):
 *
 *   TopNavigation       — top bar + window controls
 *   HeroSection         — LAUNCH button → steam://run/247660
 *   QuoteCard           — rotating Agent York quotes
 *   QuickActions        — left-column action shortcuts
 *   SettingsPanel       — right panel with sub-nav (General/Graphics/Audio/Controls/Interface/Accessibility/Advanced/About)
 *   EpisodesCarousel    — bottom-left dashboard card (mock data)
 *   UpdateCard          — live update/localization progress
 *   NewsCard            — mock news feed
 *   ProfileCard         — mock saves/profile
 *   RecentActivityCard  — mock activity log
 *   FooterStatusBar     — bottom bar with profile + socials
 *
 * Real game functionality (INI editing, DXVK, 4GB patch, redist, autosave,
 * compat mode, update check) is preserved from the previous launcher and
 * wired into the new Settings panel sections.
 */

const STEAM_APPID = '247660'; // Deadly Premonition: The Director's Cut

// ─────────────────────────────────────────────
// Shared state
// ─────────────────────────────────────────────
const state = {
  iniPath:     null,
  iniLines:    [],
  iniValues:   {},
  gamePath:    '',
  isLaunching: false,
  isLoading:   false,
  isAdmin:     false,
};

// ─────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────
const $  = (id)  => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.body.dataset.view = 'home';

  await initI18n();
  await initLanguage();

  setupTopNavigation();
  setupHeroSection();
  setupQuoteCard();
  setupSettingsPanel();
  setupSettingsNav();
  setupINIControls();
  setupCompatBlock();
  setup4GBBlock();
  setupRedistBlock();
  setupAutosaveBlock();
  setupSettingsFooter();

  setupTopNavViews();
  setupTopBarDropdowns();
  refreshNotifBadge();      // reset HTML-stub badge (0 → hidden)
  refreshDownloadsMeta();   // reset HTML-stub "1 Updates" → "0 Updates"
  setupCustomSelects();     // replace native <select> popups with styled ones
  setupFirstRunModal();
  setupAudioInterfaceControls();

  renderEpisodes();
  renderNews();
  renderProfile();
  renderActivity();
  setupFooterStatusBar();

  await loadPersistedSettings();
  await loadAppVersion();
  await autoFindIni();
  await restoreAutosaveState();
  await restoreCursorHideState();

  // Session-length watcher: launcher emits a 'session-warning' event when
  // DP.exe has been running for >3h. We surface it as a one-time toast so
  // the user knows to restart the game (audio pool exhaustion is a likely
  // crash trigger past that point — see docs/AUDIO_POOL_LEAK.md).
  window.electronAPI.onSessionWarning?.((data) => {
    const hours = Math.floor((data?.elapsedMs || 0) / (60 * 60 * 1000));
    showToast(t('toast.sessionWarning').replace('{hours}', String(hours)), 'warn', 12_000);
    logActivity('info', `Long-session reminder fired (${hours}h DP.exe uptime)`);
  });

  await maybeShowFirstRun();

  checkForUpdates();

  logActivity('info', 'Launcher started');
});

// ═════════════════════════════════════════════
// LANGUAGE
// ═════════════════════════════════════════════
async function initLanguage() {
  try {
    const saved = await window.electronAPI.settingsRead();
    if (saved.language === 'uk' || saved.language === 'en') {
      applyLang(saved.language);
      syncLangSelect();
      return;
    }
  } catch { /* first run */ }

  try {
    const locale = await window.electronAPI.getLocale();
    applyLang(locale && locale.startsWith('uk') ? 'uk' : 'en');
  } catch {
    applyLang('uk');
  }
  syncLangSelect();
}

function syncLangSelect() {
  const sel = $('form-language');
  if (sel) sel.value = getCurrentLang();
}

// ═════════════════════════════════════════════
// 1) TopNavigation
// ═════════════════════════════════════════════
function setupTopNavigation() {
  $('btn-minimize')?.addEventListener('click', () => window.electronAPI.minimizeWindow());
  $('btn-maximize')?.addEventListener('click', () => window.electronAPI.maximizeWindow?.());
  $('btn-close')?.addEventListener('click',    () => window.electronAPI.closeWindow());

  // Top-nav tabs (only HOME is functional in this build)
  $$('.topnav-link').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      $$('.topnav-link').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Notifications + downloads — placeholder, just opens settings update info
  $('btn-notifications')?.addEventListener('click', () => {
    showToast(t('toast.noNewNotifications'), 'info');
  });
  $('btn-downloads')?.addEventListener('click', () => {
    if (window.__pendingUpdate) showUpdateModal(window.__pendingUpdate);
    else showToast(t('toast.noDownloads'), 'info');
  });
}

// ═════════════════════════════════════════════
// 2) HeroSection — big red LAUNCH
// ═════════════════════════════════════════════
function setupHeroSection() {
  $('btn-launch')?.addEventListener('click', launchGame);

  $('btn-open-settings')?.addEventListener('click', () => {
    activateSettingsSection('general');
  });

  $('btn-browse-ini')?.addEventListener('click', () => {
    activateSettingsSection('graphics');
  });
}

async function launchGame() {
  if (state.isLaunching) return;
  state.isLaunching = true;

  const btn = $('btn-launch');
  btn?.classList.add('launching');
  const label = btn?.querySelector('.btn-launch-label');
  const prev  = label?.textContent;
  if (label) label.textContent = t('hero.launching');

  try {
    const res = await window.electronAPI.launchSteam(STEAM_APPID);
    if (res?.success) {
      showToast(t('toast.gameLaunchedTray'), 'success');
      logActivity('episode', 'Game launched via Steam — launcher hidden to tray');
      setTimeout(() => window.electronAPI.hideToTray(getCurrentLang()), 1500);
    } else {
      showToast(t('toast.launchError') + (res?.error || ''), 'error');
    }
  } catch (err) {
    showToast(t('toast.launchError') + err.message, 'error');
  } finally {
    state.isLaunching = false;
    btn?.classList.remove('launching');
    if (label) label.textContent = prev || t('hero.launch');
  }
}

// ═════════════════════════════════════════════
// 3) QuoteCard — rotating Agent York quotes
// ═════════════════════════════════════════════
let quoteState = { idx: 0, timer: null };

function setupQuoteCard() {
  const quotes = (window.MOCK_DATA?.quotes) || [];
  if (!quotes.length) return;

  const dotsEl = $('quote-dots');
  if (dotsEl) {
    dotsEl.innerHTML = quotes.map(() => '<span class="dot"></span>').join('');
  }

  quoteState.idx = 0;

  const restartTimer = () => {
    clearInterval(quoteState.timer);
    quoteState.timer = setInterval(tickQuote, 8000);
  };

  Array.from(dotsEl?.children || []).forEach((d, di) => {
    d.addEventListener('click', () => {
      quoteState.idx = di;
      renderQuote();
      restartTimer();
    });
  });

  $('quote-prev')?.addEventListener('click', () => {
    const n = (window.MOCK_DATA?.quotes || []).length || 1;
    quoteState.idx = (quoteState.idx - 1 + n) % n;
    renderQuote();
    restartTimer();
  });
  $('quote-next')?.addEventListener('click', () => {
    const n = (window.MOCK_DATA?.quotes || []).length || 1;
    quoteState.idx = (quoteState.idx + 1) % n;
    renderQuote();
    restartTimer();
  });

  renderQuote();
  quoteState.timer = setInterval(tickQuote, 8000);
}

function pickLocalizedTipField(q, field) {
  const lang = getCurrentLang();
  return q[`${field}_${lang}`] || q[field] || q[`${field}_en`] || q[`${field}_uk`] || (field === 'lines' ? [] : '');
}

function renderQuote() {
  const quotes = (window.MOCK_DATA?.quotes) || [];
  if (!quotes.length) return;
  const q = quotes[quoteState.idx % quotes.length];

  const lines  = pickLocalizedTipField(q, 'lines');
  const author = pickLocalizedTipField(q, 'author');

  const text = $('quote-text');
  const auth = $('quote-author');
  if (text) text.innerHTML = (Array.isArray(lines) ? lines : [String(lines)])
    .map(l => `<p>${escapeHtml(l)}</p>`).join('');
  if (auth) auth.textContent = '— ' + author;

  const dots = $('quote-dots')?.children;
  if (dots) Array.from(dots).forEach((d, di) => d.classList.toggle('active', di === (quoteState.idx % quotes.length)));
}

function tickQuote() {
  const quotes = (window.MOCK_DATA?.quotes) || [];
  if (!quotes.length) return;
  quoteState.idx = (quoteState.idx + 1) % quotes.length;
  renderQuote();
}

// ═════════════════════════════════════════════
// 4) QuickActions
// ═════════════════════════════════════════════
function setupQuickActions() {
  $$('.qa-btn').forEach(btn => {
    btn.addEventListener('click', () => handleQuickAction(btn.dataset.action));
  });
}

async function handleQuickAction(id) {
  switch (id) {
    case 'check-updates':
      showToast(t('toast.checkingUpdates'), 'info');
      await checkForUpdates(true);
      break;
    case 'verify-files':
      showToast(t('toast.placeholder'), 'info');
      break;
    case 'open-save-dir':
      showToast(t('toast.placeholder'), 'info');
      break;
    case 'open-settings':
      activateSettingsSection('general');
      break;
    case 'explore-mods':
      showToast(t('toast.placeholder'), 'info');
      break;
  }
}

// ═════════════════════════════════════════════
// 5) SettingsPanel — open/close + sub-nav
// ═════════════════════════════════════════════
function setupSettingsPanel() {
  $('btn-settings-close')?.addEventListener('click', () => {
    $('settings-panel')?.classList.add('hidden');
  });
}

function setupSettingsNav() {
  $$('.settings-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => activateSettingsSection(btn.dataset.section));
  });
}

function activateSettingsSection(name) {
  $('settings-panel')?.classList.remove('hidden');
  $$('.settings-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === name));
  $$('.settings-section').forEach(s => s.classList.toggle('active',  s.dataset.section === name));

  // "Save Changes" only writes DPfix.ini (Graphics tab values). Other tabs
  // auto-save to localStorage / apply immediately — hide the button there so
  // it isn't misleading.
  const apply = $('btn-apply');
  const reset = $('btn-reset');
  const isGraphics = name === 'graphics';
  if (apply) apply.style.display = isGraphics ? '' : 'none';
  if (reset) reset.style.display = isGraphics ? '' : 'none';

  // Refresh dynamic state when navigating into a section that needs it
  if (name === 'accessibility') {
    refreshCompatStatus();
    refreshSkipIntroStatus();
    refreshFpsCapStatus();
    refreshCodecFixStatus();
    refreshDxvkToggleStatus();
    refreshCursorHideStatus();
    refreshCaptureCursorStatus();
  }
  if (name === 'stability') {
    refreshStabilityMode();
    refreshCrashdumpStatus();
    refreshPhysxStatus();
    refreshNanGuardStatus();
    refreshGpuInfo();
  }
  if (name === 'presets') {
    detectCurrentPreset();
  }
  if (name === 'graphics')      refreshDxvkRevertStatus();
  if (name === 'dxvk')          refreshDxvkCacheStatus();
  if (name === 'advanced')      renderSavesList();
  if (name === 'log')           renderActivity();
}

function getGameDir() {
  if (!state.gamePath) return null;
  return state.gamePath.replace(/[^\\\/]*$/, '').replace(/[\\\/]$/, '');
}

async function refreshDxvkRevertStatus() {
  const statusEl = $('dxvk-revert-status');
  const btn      = $('btn-dxvk-revert');
  const note     = $('dxvk-revert-note');
  if (!btn) return;

  const gameDir = getGameDir();
  if (!gameDir) {
    btn.disabled = true;
    if (statusEl) { statusEl.textContent = t('dxvkRevert.notApplied'); statusEl.className = 'compat-status'; }
    if (note)     { note.textContent = t('dxvkRevert.noGame'); note.className = 'compat-note'; }
    return;
  }

  try {
    const r = await window.electronAPI.checkDxvkApplied?.(gameDir);
    if (r?.applied) {
      if (statusEl) { statusEl.textContent = t('dxvkRevert.applied'); statusEl.className = 'compat-status ok'; }
      btn.disabled = false;
      if (note) { note.textContent = ''; note.className = 'compat-note'; }
    } else {
      if (statusEl) { statusEl.textContent = t('dxvkRevert.notApplied'); statusEl.className = 'compat-status'; }
      btn.disabled = true;
      if (note) { note.textContent = ''; note.className = 'compat-note'; }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onDxvkRevertClick() {
  const gameDir = getGameDir();
  if (!gameDir) { showToast(t('dxvkRevert.noGame'), 'warn'); return; }

  const ok = await openConfirm({
    title:      t('dxvkRevert.confirmTitle'),
    body:       t('dxvkRevert.confirmBody'),
    okText:     t('dxvkRevert.confirmOk'),
    cancelText: t('dxvkRevert.confirmCancel'),
  });
  if (!ok) return;

  const btn  = $('btn-dxvk-revert');
  const note = $('dxvk-revert-note');
  if (btn)  btn.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }

  try {
    const r = await window.electronAPI.revertDxvkAuto?.(gameDir);
    if (r?.success) {
      showToast(t('toast.dxvkReverted'), 'success');
      logActivity('completed', 'DXVK reverted — game d3d9.dll restored, SysWOW64\\d9vk.dll removed');
      if (note) {
        note.textContent = (r.steps || []).join(' · ');
        note.className = 'compat-note ok';
      }
      refreshDxvkRevertStatus();
    } else {
      const errMsg = r?.error || 'failed';
      const needsAdmin = /admin/i.test(errMsg);
      showToast(t('toast.dxvkRevertErr') + errMsg, 'error');
      if (note) {
        note.textContent = needsAdmin ? t('dxvkRevert.needAdmin') : errMsg;
        note.className = 'compat-note error';
      }
      if (btn) btn.disabled = false;
    }
  } catch (err) {
    showToast(t('toast.dxvkRevertErr') + err.message, 'error');
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    if (btn)  btn.disabled = false;
  }
}

// Wire "Очистити журнал" button
document.addEventListener('DOMContentLoaded', () => {
  $('btn-log-clear')?.addEventListener('click', async () => {
    try {
      await window.electronAPI.activityClear?.();
      renderActivity();
      showToast('Журнал очищено ✓', 'success');
    } catch (err) {
      showToast('Помилка очистки: ' + err.message, 'error');
    }
  });

  // Settings → Graphics → Fully revert DXVK
  $('btn-dxvk-revert')?.addEventListener('click', onDxvkRevertClick);

  // Settings → About → Reset everything
  $('btn-reset-all')?.addEventListener('click', async () => {
    const ok = await openConfirm({
      title:    t('reset.confirmTitle'),
      body:     t('reset.confirmBody'),
      okText:   t('reset.confirmOk'),
      cancelText: t('reset.confirmCancel'),
    });
    if (!ok) return;
    try {
      await window.electronAPI.settingsResetAll?.();
      showToast(t('toast.resetDone'), 'success');
      setTimeout(() => window.electronAPI.relaunchApp?.(), 800);
    } catch (err) {
      showToast('Reset failed: ' + err.message, 'error');
    }
  });
});

// ═════════════════════════════════════════════
// 6) Language select (in Settings General)
// ═════════════════════════════════════════════
function setupSettingsFooter() {
  $('form-language')?.addEventListener('change', async (e) => {
    const lang = e.target.value;
    applyLang(lang);
    await persistSettings({ language: lang });
    // Re-render content that comes from data (not data-i18n attributes)
    renderQuote();
    renderNews();
    renderActivity();
  });

  $('btn-reset')?.addEventListener('click', resetDefaults);
  $('btn-apply')?.addEventListener('click', applyAndSave);
}

// ═════════════════════════════════════════════
// 7) Settings — INI editing controls (Graphics + Display)
// ═════════════════════════════════════════════
function setupINIControls() {
  $('res-preset')?.addEventListener('change', onResPresetChange);
}

function onResPresetChange() {
  const val = $('res-preset').value;
  const isCustom = val === 'custom';
  $('res-width').disabled  = !isCustom;
  $('res-height').disabled = !isCustom;
  if (!isCustom) {
    const [w, h] = val.split('×');
    $('res-width').value  = w;
    $('res-height').value = h;
  }
}

// ─── auto-detect DPfix.ini in game dir ──────────
async function autoFindIni() {
  try {
    const result = await window.electronAPI.findIni();
    if (result.needsSetup) {
      const st = $('status-text');
      if (st) st.textContent = t('status.setupRequired') || 'Setup Required';
      $('status-dot')?.classList.add('error');
      return;
    }
    if (result.found) {
      await loadIni(result.path);
    }
  } catch (err) {
    console.warn('findIni error', err);
  }
}

async function loadIni(filePath) {
  if (state.isLoading) return;
  state.isLoading = true;
  try {
    const result = await window.electronAPI.loadIni(filePath);
    state.iniPath   = filePath;
    state.iniLines  = result.lines;
    state.iniValues = result.values;
    syncUIFromValues(result.values);
    $('status-text').textContent = t('status.gameReady') || 'Game Ready';
    $('status-dot')?.classList.remove('error');
    $('status-dot')?.classList.add('ok');
    await persistSettings({ lastIniPath: filePath });
  } catch (err) {
    showToast(t('toast.iniLoadError') + err.message, 'error');
  } finally {
    state.isLoading = false;
  }
}

function syncUIFromValues(v) {
  const g = (k) => v[k] ?? DEFAULTS[k] ?? '';

  const pw = g('presentWidth'), ph = g('presentHeight');
  const presetStr = `${pw}×${ph}`;
  const presetOpts = Array.from($('res-preset').options).map(o => o.value);
  if (presetOpts.includes(presetStr)) {
    $('res-preset').value = presetStr;
    $('res-width').disabled  = true;
    $('res-height').disabled = true;
  } else {
    $('res-preset').value = 'custom';
    $('res-width').disabled  = false;
    $('res-height').disabled = false;
  }
  $('res-width').value  = pw;
  $('res-height').value = ph;

  const fw = g('forceWindowed'), bl = g('borderlessFullscreen');
  if      (fw === '1') setRadio('disp-mode', 'windowed');
  else if (bl === '1') setRadio('disp-mode', 'borderless');
  else                  setRadio('disp-mode', 'fullscreen');
  $('fullscreen-hz').value = g('fullscreenHz');

  $('aa-quality').value = g('aaQuality');
  $('aa-type').value    = g('aaType').trim().toUpperCase() === 'FXAA' ? 'FXAA' : 'SMAA';
  $('filtering').value  = g('filteringOverride');

  $('shadow-scale').value      = sanitizeScale(g('shadowMapScale'), [1,2,4]);
  setToggle('shadow-precision', g('improveShadowPrecision') === '1');
  $('reflect-scale').value     = sanitizeScale(g('reflectionScale'), [1,2,4]);

  setToggle('improve-dof', g('improveDOF') === '1');
  $('dof-blur').value = g('addDOFBlur');

  $('ssao-strength').value = g('ssaoStrength');
  $('ssao-scale').value    = g('ssaoScale');
  $('ssao-type').value     = g('ssaoType').trim().toUpperCase() === 'VSSAO2' ? 'VSSAO2' : 'VSSAO';

  setToggle('tex-dump',     g('enableTextureDumping')  === '1');
  setToggle('tex-override', g('enableTextureOverride') === '1');

  // Custom-select wrappers don't auto-update when .value is set programmatically.
  // Dispatch a synthetic change so their visible labels reflect the loaded INI.
  document.querySelectorAll('select.form-select').forEach(s => {
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function sanitizeScale(raw, allowed) {
  const n = parseInt(raw, 10);
  return allowed.includes(n) ? String(n) : String(allowed[0]);
}

function collectUIValues() {
  let w, h;
  const preset = $('res-preset').value;
  if (preset === 'custom') {
    w = parseInt($('res-width').value, 10);
    h = parseInt($('res-height').value, 10);
  } else {
    const [pw, ph] = preset.split('×');
    w = parseInt(pw, 10); h = parseInt(ph, 10);
  }
  if (!w || !h) throw new Error(t('toast.invalidRes'));

  const mode = getRadio('disp-mode');
  return {
    renderWidth: String(w),  renderHeight: String(h),
    presentWidth: String(w), presentHeight: String(h),
    forceWindowed:        mode === 'windowed'   ? '1' : '0',
    borderlessFullscreen: mode === 'borderless' ? '1' : '0',
    fullscreenHz:         String(parseInt($('fullscreen-hz').value, 10) || 60),
    aaQuality:              $('aa-quality').value,
    aaType:                 $('aa-type').value,
    filteringOverride:      $('filtering').value,
    shadowMapScale:         $('shadow-scale').value,
    improveShadowPrecision: $('shadow-precision').checked ? '1' : '0',
    reflectionScale:        $('reflect-scale').value,
    improveDOF:             $('improve-dof').checked ? '1' : '0',
    addDOFBlur:             $('dof-blur').value,
    ssaoStrength:           $('ssao-strength').value,
    ssaoScale:              $('ssao-scale').value,
    ssaoType:               $('ssao-type').value,
    enableTextureDumping:   $('tex-dump').checked ? '1' : '0',
    enableTextureOverride:  $('tex-override').checked ? '1' : '0',
    screenshotDir:          state.iniValues.screenshotDir ?? DEFAULTS.screenshotDir,
    logLevel:               state.iniValues.logLevel      ?? DEFAULTS.logLevel,
  };
}

async function applyAndSave() {
  if (!state.iniPath) {
    showToast(t('toast.selectIniFirst'), 'warn');
    return;
  }
  let values;
  try { values = collectUIValues(); }
  catch (err) { return showToast(err.message, 'error'); }

  try {
    await window.electronAPI.saveIni({
      filePath: state.iniPath,
      lines:    state.iniLines,
      values:   { ...state.iniValues, ...values },
    });
    const fresh = await window.electronAPI.loadIni(state.iniPath);
    state.iniLines = fresh.lines;
    state.iniValues = fresh.values;
    showToast(t('toast.settingsSaved'), 'success');
    logActivity('completed', 'DPfix.ini settings saved');
  } catch (err) {
    showToast(t('toast.saveError') + err.message, 'error');
  }
}

function resetDefaults() {
  syncUIFromValues(DEFAULTS);
  showToast(t('toast.reset'), 'info');
}

// ─── persistence ──────────────────────────────
async function loadPersistedSettings() {
  try {
    const saved = await window.electronAPI.settingsRead();
    if (saved.gamePath) {
      state.gamePath = saved.gamePath;
      const gp = $('game-path');
      if (gp) gp.value = saved.gamePath;
    }
  } catch { /* fresh run */ }

  // Browse-exe button
  $('btn-browse-exe')?.addEventListener('click', async () => {
    const p = await window.electronAPI.browseExe();
    if (!p) return;
    state.gamePath = p;
    $('game-path').value = p;
    await persistSettings({ gamePath: p });
    await autoFindIni();
    await refreshCompatStatus();
    onGamePathChanged();
  });
}
async function persistSettings(patch) {
  try {
    const cur = await window.electronAPI.settingsRead();
    await window.electronAPI.settingsWrite({ ...cur, ...patch });
  } catch (err) { console.warn(err); }
}

// ═════════════════════════════════════════════
// 8) COMPAT / DXVK / 4GB / Redist  blocks
// ═════════════════════════════════════════════
async function setupCompatBlock() {
  state.isAdmin = await window.electronAPI.isAdmin();
  updateAdminBanner();

  $('btn-relaunch-admin')?.addEventListener('click', async () => {
    const r = await window.electronAPI.relaunchAsAdmin();
    if (!r?.accepted) showToast(t('toast.uacCancelled'), 'warn');
  });

  $('btn-compat-toggle')?.addEventListener('click', () => toggleCompat('xpsp3'));
  $('btn-compat-win98')?.addEventListener('click',  () => toggleCompat('win98'));

  $('skip-intro-toggle')?.addEventListener('change', onSkipIntroToggle);
  $('btn-open-gpu-settings')?.addEventListener('click', onOpenGpuSettings);
  $('codec-fix-toggle')?.addEventListener('change',   onCodecFixToggle);
  $('dxvk-toggle')?.addEventListener('change',        onDxvkToggle);
  $('cursor-hide-toggle')?.addEventListener('change', onCursorHideToggle);
  $('btn-dxvk-cache-refresh')?.addEventListener('click', refreshDxvkCacheStatus);
  $('btn-dxvk-cache-clean')?.addEventListener('click',   onDxvkCacheClean);
  $('capture-cursor-toggle')?.addEventListener('change', onCaptureCursorToggle);
}

async function refreshSkipIntroStatus() {
  const toggle = $('skip-intro-toggle');
  const label  = $('skip-intro-label');
  const note   = $('skip-intro-note');
  if (!toggle) return;

  if (!state.gamePath) {
    toggle.checked  = false;
    toggle.disabled = true;
    if (label) label.textContent = t('saves.off');
    if (note)  { note.textContent = t('skipIntro.noExe'); note.className = 'compat-note'; }
    return;
  }

  toggle.disabled = false;
  try {
    const r = await window.electronAPI.checkSkipIntro?.(state.gamePath);
    if (r?.supported) {
      toggle.checked = !!r.applied;
      if (label) label.textContent = r.applied ? t('saves.on') : t('saves.off');
      if (note)  { note.textContent = ''; note.className = 'compat-note'; }
    } else {
      toggle.checked  = false;
      toggle.disabled = true;
      if (label) label.textContent = t('saves.off');
      const byte = r && typeof r.byte === 'number'
        ? ` (byte 0x${r.byte.toString(16).padStart(2,'0').toUpperCase()})` : '';
      if (note)  { note.textContent = "Unsupported .exe build" + byte; note.className = 'compat-note error'; }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onSkipIntroToggle(e) {
  const toggle = e.target;
  const enable = toggle.checked;
  // Always revert UI to "previous" state until user confirms — prevents flicker
  // showing the new state before the patch actually lands.
  toggle.checked = !enable;

  if (!state.gamePath) {
    showToast(t('skipIntro.noExe'), 'warn');
    return;
  }

  const ok = await openConfirm({
    title:      t('skipIntro.confirmTitle'),
    body:       enable ? t('skipIntro.confirmBody') : t('skipIntro.revertBody'),
    okText:     enable ? t('skipIntro.confirmOk')   : t('skipIntro.revertOk'),
    cancelText: t('skipIntro.confirmCancel'),
  });
  if (!ok) return;

  const note  = $('skip-intro-note');
  const label = $('skip-intro-label');
  toggle.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }

  try {
    const r = await window.electronAPI.applySkipIntro?.(state.gamePath, enable);
    if (r?.success) {
      toggle.checked  = enable;
      if (label) label.textContent = enable ? t('saves.on') : t('saves.off');
      if (note)  { note.textContent = ''; note.className = 'compat-note'; }
      showToast(enable ? t('toast.skipIntroOn') : t('toast.skipIntroOff'), 'success');
      logActivity(enable ? 'completed' : 'info',
                  enable ? 'Skip Intro patched (0x243333: B3→00)' : 'Skip Intro reverted (0x243333: 00→B3)');
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
      showToast(t('toast.skipIntroErr') + (r?.error || ''), 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    showToast(t('toast.skipIntroErr') + err.message, 'error');
  } finally {
    toggle.disabled = false;
  }
}

// ═════════════════════════════════════════════
// FPS Cap 60 — vendor-panel-only (button + step-by-step instructions).
// dxvk.maxFrameRate proved unreliable on Win 11 + VRR setups, so we
// only expose the authoritative path: the user's GPU control panel.
// We detect the vendor (NVIDIA/AMD/Intel), render exact step-by-step
// instructions, and open the right panel with one click.
// ═════════════════════════════════════════════
const VENDOR_DISPLAY = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', unknown: '—' };

// Step-by-step localized via i18n keys (fpsCap.steps.<vendor>.N).
function vendorStepKeys(vendor) {
  const n = vendor === 'unknown' ? 0 : 4;
  return Array.from({ length: n }, (_, i) => `fpsCap.steps.${vendor}.${i + 1}`);
}

async function refreshFpsCapStatus() {
  const note         = $('fps-cap-note');
  const gpuBtn       = $('btn-open-gpu-settings');
  const vendorBadge  = $('fps-cap-vendor-badge');
  const stepsBox     = $('fps-cap-instructions');

  try {
    // gameDir is optional now — we only use it to record the (legacy) dxvk.conf
    // state for diagnostics; the UI doesn't depend on it.
    const gameDir = getGameDir();
    const r = await window.electronAPI.checkFpsCap?.(gameDir);
    const vendor = r?.vendor || 'unknown';
    const vendorName = VENDOR_DISPLAY[vendor];

    if (vendorBadge) vendorBadge.textContent = vendorName;

    if (gpuBtn) {
      gpuBtn.dataset.vendor = vendor;
      gpuBtn.disabled       = !r?.vendorToolAvailable;
      gpuBtn.textContent    = r?.vendorToolAvailable
        ? t('fpsCap.openGpuVendor').replace('{vendor}', vendorName)
        : t('fpsCap.openGpu');
    }

    if (stepsBox) {
      const keys = vendorStepKeys(vendor);
      if (!keys.length) {
        stepsBox.innerHTML = `<p class="settings-help fix-item-help">${t('fpsCap.steps.unknown')}</p>`;
      } else {
        stepsBox.innerHTML = '<ol class="fps-cap-steps">' +
          keys.map(k => `<li>${t(k)}</li>`).join('') +
          '</ol>';
      }
    }

    if (note) { note.textContent = ''; note.className = 'compat-note'; }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onOpenGpuSettings(e) {
  const btn = e.currentTarget;
  const vendor = btn?.dataset.vendor || 'unknown';
  const note   = $('fps-cap-note');
  try {
    const r = await window.electronAPI.openGpuSettings?.(vendor);
    if (r?.success) {
      if (note) {
        note.textContent = t('fpsCap.gpuOpenedHint').replace('{vendor}', VENDOR_DISPLAY[vendor] || vendor);
        note.className   = 'compat-note ok';
      }
      logActivity('info', `Opened ${vendor} control panel for FPS-cap setup`);
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
      showToast(t('toast.fpsCapGpuErr') + (r?.error || ''), 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    showToast(t('toast.fpsCapGpuErr') + err.message, 'error');
  }
}

// ═════════════════════════════════════════════
// Codec Fix (session-scoped LAV merit lowering)
// Toggle starts/stops a detached PS watcher that:
//   1. Backs up LAV FilterData blobs from HKLM
//   2. Lowers their merit to MERIT_DO_NOT_USE
//   3. Waits for DP.exe to exit
//   4. Restores originals automatically
// Auto-revert on game close means the user never has to remember to undo.
// ═════════════════════════════════════════════
async function refreshCodecFixStatus() {
  const toggle = $('codec-fix-toggle');
  const label  = $('codec-fix-label');
  const note   = $('codec-fix-note');
  if (!toggle) return;

  try {
    const r = await window.electronAPI.checkCodecFix?.();
    if (!r?.lavInstalled) {
      toggle.checked  = false;
      toggle.disabled = true;
      if (label) label.textContent = t('saves.off');
      if (note)  { note.textContent = t('codecFix.noLav'); note.className = 'compat-note'; }
      return;
    }

    toggle.disabled = false;
    toggle.checked  = !!r.sessionActive;
    if (label) label.textContent = r.sessionActive ? t('saves.on') : t('saves.off');
    if (note)  {
      note.textContent = r.sessionActive ? t('codecFix.active') : '';
      note.className   = 'compat-note';
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onCodecFixToggle(e) {
  const toggle = e.target;
  const enable = toggle.checked;
  toggle.checked = !enable;

  if (enable && !state.isAdmin) {
    const goAdmin = await openConfirm({
      title:      t('codecFix.adminTitle'),
      body:       t('codecFix.adminBody'),
      okText:     t('codecFix.adminOk'),
      cancelText: t('skipIntro.confirmCancel'),
    });
    if (goAdmin) {
      const r = await window.electronAPI.relaunchAsAdmin();
      if (!r?.accepted) showToast(t('toast.uacCancelled'), 'warn');
    }
    return;
  }

  const ok = await openConfirm({
    title:      t('codecFix.confirmTitle'),
    body:       enable ? t('codecFix.confirmBody') : t('codecFix.revertBody'),
    okText:     enable ? t('codecFix.confirmOk')   : t('codecFix.revertOk'),
    cancelText: t('skipIntro.confirmCancel'),
  });
  if (!ok) return;

  const note  = $('codec-fix-note');
  const label = $('codec-fix-label');
  toggle.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }

  try {
    const r = enable
      ? await window.electronAPI.startCodecFix?.('DP')
      : await window.electronAPI.stopCodecFix?.();
    if (r?.success) {
      toggle.checked  = enable;
      if (label) label.textContent = enable ? t('saves.on') : t('saves.off');
      if (note)  {
        note.textContent = enable ? t('codecFix.active') : '';
        note.className   = 'compat-note';
      }
      showToast(enable ? t('toast.codecFixOn') : t('toast.codecFixOff'), 'success');
      logActivity(enable ? 'completed' : 'info',
                  enable ? 'Codec-Fix session started (LAV merit → DO_NOT_USE for this game session)'
                         : 'Codec-Fix session stopped (LAV merits restored)');
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
      showToast(t('toast.codecFixErr') + (r?.error || ''), 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    showToast(t('toast.codecFixErr') + err.message, 'error');
  } finally {
    toggle.disabled = false;
  }
}

// ═════════════════════════════════════════════
// DXVK toggle (Vulkan wrapper on/off)
// ON  → apply-dxvk-auto:  hex-patches game/d3d9.dll to forward to d9vk.dll +
//                         copies DXVK d3d9.dll to SysWOW64\d9vk.dll
// OFF → revert-dxvk-auto: restores game/d3d9.dll (from .bak or hex-undo) +
//                         deletes SysWOW64\d9vk.dll
//
// In both states DPfix hex-patches in DP.exe stay active (widescreen/FOV/4GB
// patch are baked into the exe, not the d3d9.dll wrapper). The only thing
// this toggle controls is whether D3D9 calls go through Vulkan or native.
// ═════════════════════════════════════════════
async function refreshDxvkToggleStatus() {
  const toggle = $('dxvk-toggle');
  const label  = $('dxvk-toggle-label');
  const note   = $('dxvk-toggle-note');
  if (!toggle) return;
  const gameDir = getGameDir();
  if (!gameDir) {
    toggle.disabled = true;
    if (label) label.textContent = t('saves.off');
    return;
  }
  try {
    const r = await window.electronAPI.checkDxvkApplied?.(gameDir);
    const applied = !!(r?.systemDll && r?.gamePatched);
    toggle.disabled = false;
    toggle.checked  = applied;
    if (label) label.textContent = applied ? t('saves.on') : t('saves.off');
    if (note) {
      note.textContent = '';
      note.className = 'compat-note';
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onDxvkToggle(e) {
  const toggle = e.target;
  const enable = toggle.checked;
  toggle.checked = !enable;  // revert until we confirm

  const gameDir = getGameDir();
  if (!gameDir) {
    showToast(t('toast.noGameDir') || 'Game dir unknown', 'error');
    return;
  }

  if (!state.isAdmin) {
    const goAdmin = await openConfirm({
      title:      t('dxvkToggle.adminTitle'),
      body:       t('dxvkToggle.adminBody'),
      okText:     t('dxvkToggle.adminOk'),
      cancelText: t('skipIntro.confirmCancel'),
    });
    if (goAdmin) {
      const r = await window.electronAPI.relaunchAsAdmin();
      if (!r?.accepted) showToast(t('toast.uacCancelled'), 'warn');
    }
    return;
  }

  const ok = await openConfirm({
    title:      enable ? t('dxvkToggle.enableTitle') : t('dxvkToggle.disableTitle'),
    body:       enable ? t('dxvkToggle.enableBody')  : t('dxvkToggle.disableBody'),
    okText:     enable ? t('dxvkToggle.enableOk')    : t('dxvkToggle.disableOk'),
    cancelText: t('skipIntro.confirmCancel'),
  });
  if (!ok) return;

  const note  = $('dxvk-toggle-note');
  const label = $('dxvk-toggle-label');
  toggle.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }

  try {
    const r = enable
      ? await window.electronAPI.applyDxvkAuto?.(gameDir)
      : await window.electronAPI.revertDxvkAuto?.(gameDir);
    if (r?.success) {
      toggle.checked = enable;
      if (label) label.textContent = enable ? t('saves.on') : t('saves.off');
      if (note) {
        note.textContent = (r.steps || []).join(' · ');
        note.className   = 'compat-note ok';
      }
      showToast(enable ? t('toast.dxvkApplied') : t('toast.dxvkReverted'), 'success');
      logActivity(enable ? 'completed' : 'info',
                  enable ? 'DXVK enabled — d3d9.dll patched, SysWOW64\\d9vk.dll installed'
                         : 'DXVK disabled — d3d9.dll restored, SysWOW64\\d9vk.dll removed');
    } else {
      const errMsg = r?.error || 'failed';
      const needsAdmin = /admin/i.test(errMsg);
      if (note) {
        note.textContent = needsAdmin ? t('dxvkToggle.needAdmin') : errMsg;
        note.className = 'compat-note error';
      }
      showToast((enable ? t('toast.dxvkApplyErr') : t('toast.dxvkRevertErr')) + errMsg, 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    showToast((enable ? t('toast.dxvkApplyErr') : t('toast.dxvkRevertErr')) + err.message, 'error');
  } finally {
    toggle.disabled = false;
    refreshDxvkRevertStatus?.();
  }
}

// ═════════════════════════════════════════════
// Cursor Hide (background PS watcher) — preference persists across launcher
// restarts. On launcher startup, if the preference is ON, the watcher is
// auto-spawned (it'll sit waiting for DP.exe to start, then attach). User
// only flips the toggle once.
// ═════════════════════════════════════════════
async function refreshCursorHideStatus() {
  // Reads saved preference and reflects it in the toggle. Does NOT spawn
  // a new watcher — that happens on toggle change or on initial restore.
  const toggle = $('cursor-hide-toggle');
  const label  = $('cursor-hide-label');
  const note   = $('cursor-hide-note');
  if (!toggle) return;
  try {
    const saved   = await window.electronAPI.settingsRead();
    const enabled = !!saved.cursorHideEnabled;
    toggle.checked = enabled;
    toggle.disabled = false;
    if (label) label.textContent = enabled ? t('saves.on') : t('saves.off');
    if (note)  {
      note.textContent = enabled ? t('cursorHide.active') : '';
      note.className   = 'compat-note';
    }
  } catch { /* ignore */ }
}

async function restoreCursorHideState() {
  // Called once at launcher startup, after loadPersistedSettings. If the
  // user had cursor-hide enabled in a previous session, fire up the
  // detached watcher again so it's ready by the time they launch the game.
  try {
    const saved = await window.electronAPI.settingsRead();
    if (saved.cursorHideEnabled) {
      await window.electronAPI.startCursorHide?.('DP');
    }
  } catch { /* ignore */ }
}

async function onCursorHideToggle(e) {
  const toggle = e.target;
  const enable = toggle.checked;
  toggle.checked = !enable;

  const note  = $('cursor-hide-note');
  const label = $('cursor-hide-label');
  toggle.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }

  try {
    const r = enable
      ? await window.electronAPI.startCursorHide?.('DP')
      : await window.electronAPI.stopCursorHide?.();
    if (r?.success) {
      toggle.checked  = enable;
      if (label) label.textContent = enable ? t('saves.on') : t('saves.off');
      if (note)  {
        note.textContent = enable ? t('cursorHide.active') : '';
        note.className   = 'compat-note';
      }
      // Persist preference so the watcher auto-starts on next launcher run.
      await persistSettings({ cursorHideEnabled: enable });
      showToast(enable ? t('toast.cursorHideOn') : t('toast.cursorHideOff'), 'success');
      logActivity('info',
                  enable ? 'Cursor-hide watcher started (waiting for DP.exe)'
                         : 'Cursor-hide watcher stopped');
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
      showToast(t('toast.cursorHideErr') + (r?.error || ''), 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    showToast(t('toast.cursorHideErr') + err.message, 'error');
  } finally {
    toggle.disabled = false;
  }
}

// ═════════════════════════════════════════════
// DPfix CaptureCursor — writes/removes `CaptureCursor N` in DPfix.ini.
// Works at the D3D9 wrapper layer, alternative to our PS-based watcher.
// Persistent (lives in INI), no separate process needed.
// ═════════════════════════════════════════════
async function refreshCaptureCursorStatus() {
  const toggle = $('capture-cursor-toggle');
  const label  = $('capture-cursor-label');
  const note   = $('capture-cursor-note');
  if (!toggle) return;

  const gameDir = getGameDir();
  if (!gameDir) {
    toggle.checked  = false;
    toggle.disabled = true;
    if (label) label.textContent = t('saves.off');
    if (note)  { note.textContent = t('skipIntro.noExe'); note.className = 'compat-note'; }
    return;
  }

  try {
    const r = await window.electronAPI.checkCaptureCursor?.(gameDir);
    if (!r?.iniExists) {
      toggle.checked  = false;
      toggle.disabled = true;
      if (label) label.textContent = t('saves.off');
      if (note)  { note.textContent = t('captureCursor.noIni'); note.className = 'compat-note error'; }
      return;
    }
    toggle.disabled = false;
    toggle.checked  = !!r.applied;
    if (label) label.textContent = r.applied ? t('saves.on') : t('saves.off');
    if (note)  { note.textContent = ''; note.className = 'compat-note'; }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onCaptureCursorToggle(e) {
  const toggle = e.target;
  const enable = toggle.checked;
  toggle.checked = !enable;

  const gameDir = getGameDir();
  if (!gameDir) {
    showToast(t('skipIntro.noExe'), 'warn');
    return;
  }

  const note  = $('capture-cursor-note');
  const label = $('capture-cursor-label');
  toggle.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }

  try {
    const r = await window.electronAPI.applyCaptureCursor?.(gameDir, enable);
    if (r?.success) {
      toggle.checked = enable;
      if (label) label.textContent = enable ? t('saves.on') : t('saves.off');
      if (note)  {
        note.textContent = enable ? t('captureCursor.activeHint') : '';
        note.className   = 'compat-note';
      }
      showToast(enable ? t('toast.captureCursorOn') : t('toast.captureCursorOff'), 'success');
      logActivity(enable ? 'completed' : 'info',
                  enable ? 'DPfix CaptureCursor enabled in DPfix.ini'
                         : 'DPfix CaptureCursor disabled in DPfix.ini');
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
      showToast(t('toast.captureCursorErr') + (r?.error || ''), 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    showToast(t('toast.captureCursorErr') + err.message, 'error');
  } finally {
    toggle.disabled = false;
  }
}

// ═════════════════════════════════════════════
// DXVK Cache — info display + cleanup. On modern drivers DXVK delegates
// shader caching to the driver (NVIDIA DXCache / AMD DxCache), so the
// per-game .dxvk-cache file often doesn't exist. We still surface the
// state honestly + offer cleanup if the file is there.
// ═════════════════════════════════════════════
function humanBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function humanDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return iso; }
}

async function refreshDxvkCacheStatus() {
  const grid    = $('dxvk-cache-grid');
  const badge   = $('dxvk-cache-badge');
  const cleanBtn = $('btn-dxvk-cache-clean');
  const note    = $('dxvk-cache-note');
  if (!grid) return;

  const gameDir = getGameDir();
  if (!gameDir) {
    grid.innerHTML = '';
    if (badge) badge.textContent = '—';
    if (cleanBtn) cleanBtn.disabled = true;
    if (note) { note.textContent = t('skipIntro.noExe'); note.className = 'compat-note'; }
    return;
  }

  try {
    const r = await window.electronAPI.dxvkCacheInfo?.(gameDir);
    if (!r) {
      if (note) { note.textContent = 'no data'; note.className = 'compat-note error'; }
      return;
    }
    const dxvkCount = r.dxvk?.files?.length || 0;
    const dxvkSize  = r.dxvk?.totalSize || 0;
    const nvidiaSize  = r.driver?.nvidiaDxCache?.totalSize || 0;
    const nvidiaCount = r.driver?.nvidiaDxCache?.fileCount || 0;
    const amdSize     = r.driver?.amdShaderCache?.totalSize || 0;
    const amdCount    = r.driver?.amdShaderCache?.fileCount || 0;

    if (badge) {
      badge.textContent = dxvkCount > 0
        ? humanBytes(dxvkSize)
        : t('dxvkCache.driverOnly');
    }
    if (cleanBtn) cleanBtn.disabled = dxvkCount === 0;

    // Build info grid
    const rows = [];
    rows.push(`<div class="info-grid-row">
      <span class="info-grid-key">${t('dxvkCache.dxvkLabel')}</span>
      <span class="info-grid-val">${
        dxvkCount > 0
          ? `${dxvkCount} file(s), ${humanBytes(dxvkSize)}, ${humanDate(r.dxvk.newestMtime)}`
          : `<em>${t('dxvkCache.dxvkNone')}</em>`
      }</span>
    </div>`);
    if (nvidiaSize > 0) {
      rows.push(`<div class="info-grid-row">
        <span class="info-grid-key">${t('dxvkCache.nvidiaLabel')}</span>
        <span class="info-grid-val">${nvidiaCount} file(s), ${humanBytes(nvidiaSize)}, ${humanDate(r.driver.nvidiaDxCache.newestMtime)}</span>
      </div>`);
    }
    if (amdSize > 0) {
      rows.push(`<div class="info-grid-row">
        <span class="info-grid-key">${t('dxvkCache.amdLabel')}</span>
        <span class="info-grid-val">${amdCount} file(s), ${humanBytes(amdSize)}, ${humanDate(r.driver.amdShaderCache.newestMtime)}</span>
      </div>`);
    }
    grid.innerHTML = rows.join('');

    if (note) {
      if (dxvkCount === 0 && (nvidiaSize > 0 || amdSize > 0)) {
        note.textContent = t('dxvkCache.noteDriverOnly');
        note.className   = 'compat-note';
      } else {
        note.textContent = '';
        note.className   = 'compat-note';
      }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onDxvkCacheClean() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const ok = await openConfirm({
    title:      t('dxvkCache.cleanTitle'),
    body:       t('dxvkCache.cleanBody'),
    okText:     t('dxvkCache.cleanOk'),
    cancelText: t('skipIntro.confirmCancel'),
    danger:     true,
  });
  if (!ok) return;
  try {
    const r = await window.electronAPI.dxvkCacheClean?.(gameDir);
    if (r?.success) {
      showToast(t('toast.dxvkCacheCleaned').replace('{n}', r.deleted), 'success');
      logActivity('info', `DXVK cache cleaned: ${r.deleted} file(s)`);
      await refreshDxvkCacheStatus();
    } else {
      showToast(t('toast.dxvkCacheErr') + (r?.error || r?.errors?.join('; ') || 'failed'), 'error');
    }
  } catch (err) {
    showToast(t('toast.dxvkCacheErr') + err.message, 'error');
  }
}

function updateAdminBanner() {
  const banner = $('compat-admin-banner');
  if (banner) banner.style.display = state.isAdmin ? 'none' : 'flex';
  const compat = $('btn-compat-toggle');
  if (compat) compat.disabled = !state.isAdmin || !state.gamePath;
  const compat98 = $('btn-compat-win98');
  if (compat98) compat98.disabled = !state.isAdmin || !state.gamePath;
  const fourGB = $('btn-4gb-patch');
  if (fourGB) fourGB.disabled = !state.gamePath;
  const redist = $('btn-install-redist');
  if (redist) redist.disabled = !state.gamePath;
  const hasSrc = !!$('dxvk-src-path')?.value;
  const di = $('btn-dxvk-install');
  if (di) di.disabled = !state.isAdmin || !hasSrc;
  const du = $('btn-dxvk-uninstall');
  if (du) du.disabled = !state.isAdmin;
}

async function refreshCompatStatus() {
  if (!state.gamePath) return;
  updateAdminBanner();
  const gameDir = state.gamePath.replace(/[^\\\/]*$/, '');
  const [s1, s2] = await Promise.all([
    window.electronAPI.getCompatStatus(state.gamePath),
    window.electronAPI.getCompatStatus(gameDir + 'DPLauncher.exe'),
  ]);
  setCompatStatus('compat-status-dp',       s1);
  setCompatStatus('compat-status-launcher', s2);

  // Both labels reflect the joint mode (only when BOTH exes share the same mode)
  const joint = (s1 === s2 && s1 !== 'none') ? s1 : 'none';
  const xpBtn   = $('btn-compat-toggle');
  const w98Btn  = $('btn-compat-win98');
  if (xpBtn)  xpBtn.textContent  = joint === 'xpsp3' ? 'Remove XP SP3'    : 'Apply XP SP3';
  if (w98Btn) w98Btn.textContent = joint === 'win98' ? 'Remove Win 98/Me' : 'Apply Win 98 / Me';
}
function setCompatStatus(id, status) {
  const el = $(id);
  if (!el) return;
  if      (status === 'xpsp3') { el.textContent = '✓ XP SP3';      el.className = 'compat-status ok'; }
  else if (status === 'win98') { el.textContent = '✓ Win 98 / Me'; el.className = 'compat-status ok'; }
  else                          { el.textContent = '— not set';     el.className = 'compat-status'; }
}

async function toggleCompat(mode) {
  if (!state.isAdmin || !state.gamePath) return;
  const xpBtn  = $('btn-compat-toggle');
  const w98Btn = $('btn-compat-win98');
  const btn  = mode === 'win98' ? w98Btn : xpBtn;
  const note = $('compat-note');
  const removing = btn.textContent.toLowerCase().includes('remove');

  xpBtn  && (xpBtn.disabled  = true);
  w98Btn && (w98Btn.disabled = true);
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }

  try {
    const gameDir   = state.gamePath.replace(/[^\\\/]*$/, '');
    const launchExe = gameDir + 'DPLauncher.exe';

    if (removing) {
      await Promise.all([
        window.electronAPI.removeCompat(state.gamePath),
        window.electronAPI.removeCompat(launchExe),
      ]);
      if (note) { note.textContent = mode === 'win98'
        ? t('compat.note.removed98') : t('compat.note.removedXP');
        note.className = 'compat-note ok'; }
    } else {
      await Promise.all([
        window.electronAPI.setCompat(state.gamePath, mode),
        window.electronAPI.setCompat(launchExe,      mode),
      ]);
      if (note) { note.textContent = mode === 'win98'
        ? t('compat.note.applied98') : t('compat.note.appliedXP');
        note.className = 'compat-note ok'; }
      logActivity('completed', `Compat → ${mode}`);
    }
    await refreshCompatStatus();
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onGamePathChanged() {
  updateAdminBanner();
  // (Re)start autosave worker whenever the game path changes — fixes the
  // case where state.gamePath gets set AFTER restoreAutosaveState() has
  // already run (e.g. first-run wizard, or browse-exe on a launcher with
  // no settings.json). Idempotent: stop+start.
  try {
    const saved = await window.electronAPI.settingsRead();
    const enabled = saved.autosaveEnabled !== false; // default ON
    if (enabled && state.gamePath) {
      const gameDir = state.gamePath.replace(/[^\\\/]*$/, '').replace(/[\\\/]$/, '');
      await window.electronAPI.autosaveStop?.();
      await window.electronAPI.autosaveStart(gameDir, 120000);
      const note = $('autosave-note');
      if (note) { note.textContent = t('saves.autoActive') || 'Auto-backup active ✓'; note.className = 'compat-note ok'; }
    }
  } catch { /* ignore */ }
}

// ─── DXVK ─────────────────────────────────────
function setupDXVKBlock() {
  $('btn-dxvk-browse')?.addEventListener('click', async () => {
    const p = await window.electronAPI.browseDll();
    if (p) {
      $('dxvk-src-path').value = p;
      $('btn-dxvk-install').disabled = !state.isAdmin;
    }
  });
  $('btn-dxvk-install')?.addEventListener('click', installDxvk);
  $('btn-dxvk-uninstall')?.addEventListener('click', uninstallDxvk);
  refreshDxvkStatus();
}
async function refreshDxvkStatus() {
  try {
    const ok = await window.electronAPI.checkDxvk();
    const el = $('dxvk-status');
    if (ok) { el.textContent = '✓ installed';  el.classList.add('ok'); $('btn-dxvk-uninstall').disabled = !state.isAdmin; }
    else    { el.textContent = '— not installed'; el.classList.remove('ok'); }

    if (!$('dxvk-src-path').value) {
      const bundled = await window.electronAPI.getBundledDxvk();
      if (bundled) {
        $('dxvk-src-path').value = bundled;
        $('btn-dxvk-install').disabled = !state.isAdmin;
      }
    }
  } catch { /* ignore */ }
}
async function installDxvk() {
  const src = $('dxvk-src-path').value;
  const note = $('dxvk-note');
  if (!src || !state.isAdmin) return;
  $('btn-dxvk-install').disabled = true;
  if (note) { note.textContent = 'Copying…'; note.className = 'compat-note'; }
  try {
    await window.electronAPI.installDxvk(src);
    if (note) { note.textContent = '✓ d9vk.dll copied to SysWOW64.'; note.className = 'compat-note ok'; }
    refreshDxvkStatus();
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    $('btn-dxvk-install').disabled = false;
  }
}
async function uninstallDxvk() {
  const note = $('dxvk-note');
  if (!state.isAdmin) return;
  $('btn-dxvk-uninstall').disabled = true;
  if (note) { note.textContent = 'Removing…'; note.className = 'compat-note'; }
  try {
    await window.electronAPI.uninstallDxvk();
    if (note) { note.textContent = '✓ DXVK removed.'; note.className = 'compat-note ok'; }
    refreshDxvkStatus();
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    $('btn-dxvk-uninstall').disabled = false;
  }
}

// ─── 4GB patch ────────────────────────────────
function setup4GBBlock() {
  $('btn-4gb-patch')?.addEventListener('click', async () => {
    if (!state.gamePath) return;
    const note = $('patch-note');
    const btn  = $('btn-4gb-patch');
    btn.disabled = true;
    if (note) { note.textContent = 'Running patch…'; note.className = 'compat-note'; }
    try {
      const r = await window.electronAPI.run4gbPatch(state.gamePath);
      if (note) {
        if (r.success) { note.textContent = '✓ 4GB patch applied.'; note.className = 'compat-note ok'; }
        else           { note.textContent = `Error: ${r.error || ''}`;    note.className = 'compat-note error'; }
      }
    } catch (err) {
      if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Redist ───────────────────────────────────
function setupRedistBlock() {
  $('btn-install-redist')?.addEventListener('click', async () => {
    if (!state.gamePath) return;
    const note = $('redist-note');
    const btn  = $('btn-install-redist');
    btn.disabled = true;
    if (note) { note.textContent = 'Running installers…'; note.className = 'compat-note'; }
    try {
      const gameDir = state.gamePath.replace(/[^\\\/]*$/, '').replace(/[\\\/]$/, '');
      const results = await window.electronAPI.installRedist(gameDir);
      if (!results.length) {
        if (note) { note.textContent = 'No files found in redist folder.'; note.className = 'compat-note error'; }
      } else {
        const failed = results.filter(r => !r.success);
        if (note) {
          if (failed.length) { note.textContent = 'Errors: ' + failed.map(r => r.file).join(', '); note.className = 'compat-note error'; }
          else               { note.textContent = '✓ Installed: ' + results.map(r => r.file).join(', '); note.className = 'compat-note ok'; }
        }
      }
    } catch (err) {
      if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Autosave ─────────────────────────────────
function setupAutosaveBlock() {
  $('autosave-toggle')?.addEventListener('change', async () => {
    const enabled = $('autosave-toggle').checked;
    const note = $('autosave-note');
    const gameDir = state.gamePath.replace(/[^\\\/]*$/, '').replace(/[\\\/]$/, '');
    if (enabled && gameDir) {
      await window.electronAPI.autosaveStart(gameDir, 120000);
      if (note) { note.textContent = 'Auto-backup enabled.'; note.className = 'compat-note ok'; }
      await persistSettings({ autosaveEnabled: true });
    } else {
      await window.electronAPI.autosaveStop();
      if (note) { note.textContent = 'Auto-backup disabled.'; note.className = 'compat-note'; }
      await persistSettings({ autosaveEnabled: false });
    }
  });

  window.electronAPI.onAutosaveEvent?.((msg) => {
    const note = $('autosave-note');
    if (msg.type === 'backup-created') {
      if (note) {
        note.textContent = `Backup created — ${msg.timestamp}`;
        note.className   = 'compat-note ok';
      }
      // Re-render the backups list so the new entry appears immediately.
      renderSavesList();
    } else if (msg.type === 'no-save') {
      if (note) { note.textContent = 'dp.sav not found.'; note.className = 'compat-note error'; }
      $('autosave-toggle').checked = false;
    } else if (msg.type === 'error') {
      if (note) {
        note.textContent = 'Auto-backup error: ' + msg.error;
        note.className = 'compat-note error';
      }
    }
  });
}

// ═════════════════════════════════════════════
// Saves List
// Reads `savesList(gameDir)` → renders one card per backup, with
// description input + Restore / Delete buttons.
// ═════════════════════════════════════════════
function formatBackupDate(iso) {
  try {
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return iso; }
}

function formatBackupSize(bytes) {
  if (typeof bytes !== 'number') return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Character byte at save offset 0x5CA (per Steam community RE).
const SAVE_CHARACTERS = {
  0: 'York',
  1: 'Emily',
  2: 'Kid York',
  3: 'Raincoat Killer',
  4: 'Zach',
};
function characterName(byte) {
  if (byte === null || byte === undefined) return null;
  return SAVE_CHARACTERS[byte] || `#${byte}`;
}

function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function renderSavesList() {
  const list = $('saves-list');
  if (!list) return;

  const gameDir = getGameDir();
  if (!gameDir) {
    list.innerHTML = `<p class="settings-placeholder" id="saves-empty">${t('saves.empty')}</p>`;
    return;
  }

  let entries = [];
  try { entries = await window.electronAPI.savesList?.(gameDir) || []; }
  catch { entries = []; }

  if (!entries.length) {
    list.innerHTML = `<p class="settings-placeholder" id="saves-empty">${t('saves.empty')}</p>`;
    return;
  }

  list.innerHTML = entries.map((e, idx) => {
    const date = formatBackupDate(e.date);
    const size = formatBackupSize(e.size);
    const char = characterName(e.character);
    // Compact metaline shown in summary: description (if any) • character • size
    const metaParts = [];
    if (e.description) metaParts.push(`<span class="save-item-desc-inline">${escapeAttr(e.description)}</span>`);
    if (char)          metaParts.push(`<span class="save-item-char">${escapeAttr(char)}</span>`);
    if (size)          metaParts.push(`<span class="save-item-size">${size}</span>`);
    const metaHtml = metaParts.join(' <span class="save-item-sep">·</span> ');

    return `
      <details class="save-item" data-id="${escapeAttr(e.id)}"${idx === 0 ? ' open' : ''}>
        <summary>
          <span class="save-item-date">${date}</span>
          <span class="save-item-meta">${metaHtml}</span>
        </summary>
        <div class="save-item-body">
          <input
            type="text"
            class="save-item-desc"
            placeholder="${escapeAttr(t('saves.descPlaceholder'))}"
            value="${escapeAttr(e.description || '')}"
          />
          <div class="save-item-actions">
            <button class="btn-secondary btn-compact save-restore" data-id="${escapeAttr(e.id)}">${t('saves.restore')}</button>
            <button class="btn-secondary btn-compact save-delete"  data-id="${escapeAttr(e.id)}">${t('saves.delete')}</button>
          </div>
        </div>
      </details>
    `;
  }).join('');

  // Wire actions
  list.querySelectorAll('.save-restore').forEach(btn => {
    btn.addEventListener('click', (e) => { e.preventDefault(); onSaveRestore(btn.dataset.id); });
  });
  list.querySelectorAll('.save-delete').forEach(btn => {
    btn.addEventListener('click', (e) => { e.preventDefault(); onSaveDelete(btn.dataset.id); });
  });
  list.querySelectorAll('.save-item-desc').forEach(inp => {
    inp.addEventListener('change', () => onSaveDescChange(inp.closest('.save-item').dataset.id, inp.value));
    // Don't toggle <details> when typing in description
    inp.addEventListener('click', (e) => e.stopPropagation());
  });
}

async function onSaveRestore(id) {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const ok = await openConfirm({
    title:      t('saves.restoreTitle'),
    body:       t('dyn.savesConfirmRestore').replace('{id}', id),
    okText:     t('saves.restoreOk'),
    cancelText: t('skipIntro.confirmCancel'),
  });
  if (!ok) return;
  try {
    await window.electronAPI.savesRestore(gameDir, id);
    showToast(t('dyn.savesRestored'), 'success');
    logActivity('completed', `Save restored from backup ${id}`);
  } catch (err) {
    showToast(t('toast.saveRestoreErr') + err.message, 'error');
  }
}

async function onSaveDelete(id) {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const ok = await openConfirm({
    title:      t('saves.deleteTitle'),
    body:       t('dyn.savesConfirmDelete').replace('{id}', id),
    okText:     t('saves.deleteOk'),
    cancelText: t('skipIntro.confirmCancel'),
    danger:     true,
  });
  if (!ok) return;
  try {
    await window.electronAPI.savesDelete(gameDir, id);
    showToast(t('dyn.savesDeleted'), 'success');
    logActivity('info', `Save backup ${id} deleted`);
    renderSavesList();
  } catch (err) {
    showToast(t('toast.saveDeleteErr') + err.message, 'error');
  }
}

async function onSaveDescChange(id, desc) {
  const gameDir = getGameDir();
  if (!gameDir) return;
  try { await window.electronAPI.savesSetDesc(gameDir, id, desc); }
  catch { /* silent */ }
}

async function restoreAutosaveState() {
  try {
    const saved = await window.electronAPI.settingsRead();
    // Default ON: enable autosave unless user explicitly disabled it
    const enabled = saved.autosaveEnabled !== false;
    const toggle = $('autosave-toggle');
    if (toggle) toggle.checked = enabled;

    if (enabled && state.gamePath) {
      const gameDir = state.gamePath.replace(/[^\\\/]*$/, '').replace(/[\\\/]$/, '');
      await window.electronAPI.autosaveStart(gameDir, 120000);
      const note = $('autosave-note');
      if (note) { note.textContent = t('saves.autoActive') || 'Auto-backup active ✓'; note.className = 'compat-note ok'; }
      // Persist the default-on state on first run
      if (saved.autosaveEnabled === undefined) {
        await persistSettings({ autosaveEnabled: true });
      }
    }
  } catch { /* none */ }
}

// ═════════════════════════════════════════════
// 9) EpisodesCarousel
// ═════════════════════════════════════════════
function renderEpisodes() {
  const row = $('episodes-row');
  if (!row) return;
  const eps = window.MOCK_DATA?.episodes || [];
  row.innerHTML = eps.map(ep => `
    <div class="episode" data-id="${ep.id}">
      <span class="episode-pin"></span>
      <div class="episode-num">${ep.code}</div>
      <div class="episode-meta">
        <div class="episode-kind">${escapeHtml(ep.kind)}</div>
        <div class="episode-title">${escapeHtml(ep.title)}</div>
      </div>
    </div>`).join('');
}

// ═════════════════════════════════════════════
// 10) NewsCard
// ═════════════════════════════════════════════
// Cached news items used by both the dashboard card and the View All modal
let newsCache = [];

function pickLocalizedNewsField(n, field) {
  const lang = getCurrentLang();
  return n[`${field}_${lang}`] || n[field] || n[`${field}_en`] || n[`${field}_uk`] || '';
}

async function renderNews() {
  const list = $('news-list');
  if (!list) return;

  const renderItems = (items) => {
    newsCache = items;
    list.innerHTML = items.slice(0, 3).map((n, i) => `
      <div class="news-item" data-news-idx="${i}">
        <div class="news-thumb">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h6"/></svg>
        </div>
        <div class="news-info">
          <div class="news-title">${escapeHtml(pickLocalizedNewsField(n, 'title'))}</div>
          <div class="news-excerpt">${escapeHtml(pickLocalizedNewsField(n, 'excerpt'))}</div>
          <span class="news-date">${escapeHtml(n.date || '')}</span>
        </div>
      </div>`).join('');

    // Clicking a news item: open its URL on GitHub if provided, else open the full modal
    list.querySelectorAll('.news-item').forEach((el, i) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const item = items[i];
        if (item?.url) window.electronAPI.openExternal(item.url);
        else           openNewsModal();
      });
    });
  };
  renderItems(window.MOCK_DATA?.news || []);

  // Try GitHub feed; override on success
  try {
    const r = await window.electronAPI.fetchNews?.();
    if (r && Array.isArray(r.items) && r.items.length) {
      renderItems(r.items);
    }
  } catch { /* silent — keep mock */ }
}

function openNewsModal() {
  const overlay = $('news-overlay');
  const body    = $('news-modal-body');
  if (!overlay || !body) return;

  if (!newsCache.length) {
    body.innerHTML = '<p class="settings-placeholder">Поки що новин немає.</p>';
  } else {
    body.innerHTML = newsCache.map(n => `
      <div class="news-item">
        <div class="news-thumb">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h10M7 13h6"/></svg>
        </div>
        <div class="news-info">
          <div class="news-title">${escapeHtml(pickLocalizedNewsField(n, 'title'))}</div>
          <div class="news-excerpt">${escapeHtml(pickLocalizedNewsField(n, 'excerpt'))}</div>
          <span class="news-date">${escapeHtml(n.date || '')}</span>
        </div>
      </div>
    `).join('');
  }
  overlay.classList.remove('hidden');
}
function closeNewsModal() { $('news-overlay')?.classList.add('hidden'); }

// Wire the "View All" button + close button + outside-click
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-action="view-news"]').forEach(btn => {
    btn.addEventListener('click', openNewsModal);
  });
  $('btn-news-close')?.addEventListener('click', closeNewsModal);
  $('news-overlay')?.addEventListener('click', (e) => {
    if (e.target === $('news-overlay')) closeNewsModal();
  });
});

// ═════════════════════════════════════════════
// 11) ProfileCard
// ═════════════════════════════════════════════
function renderProfile() {
  const p = window.MOCK_DATA?.profile;
  if (!p) return;
  const initials = p.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const set = (id, val) => { const el = $(id); if (el) el.textContent = val; };
  set('profile-initials', initials);
  set('profile-name',     p.name);
  set('profile-cases',    `${p.casesDone}/${p.casesAll}`);
  set('profile-time',     p.playTime);
  set('footer-name',      p.role || p.name);

  const fa = $('footer-avatar')?.querySelector('span');
  if (fa) fa.textContent = initials;
}

// ═════════════════════════════════════════════
// 12) RecentActivityCard
// ═════════════════════════════════════════════
async function renderActivity() {
  const list = $('activity-list');
  if (!list) return;

  let items = [];
  try { items = (await window.electronAPI.activityRead?.()) || []; } catch {}
  // No mock fallback — empty journal stays empty after a clear

  const iconFor = (k) => ({
    completed:  '<path d="M5 12l5 5L20 7"/>',
    collected:  '<circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/>',
    episode:    '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M12 10v4"/>',
    screenshot: '<rect x="3" y="6" width="18" height="13" rx="2"/><circle cx="12" cy="13" r="3"/>',
    info:       '<circle cx="12" cy="12" r="9"/><path d="M12 8h0M12 12v4"/>',
  }[k] || '<circle cx="12" cy="12" r="3"/>');

  const formatActivityDate = (raw) => {
    if (!raw) return '';
    // ISO from main process → localised; plain string from mock → as-is
    if (typeof raw === 'string' && raw.includes('T') && raw.endsWith('Z')) {
      try {
        return new Date(raw).toLocaleString(
          getCurrentLang() === 'uk' ? 'uk-UA' : 'en-US',
          { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
        );
      } catch { return raw; }
    }
    return raw;
  };

  list.innerHTML = items.slice(0, 8).map(a => `
    <li class="activity-item">
      <span class="activity-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${iconFor(a.kind)}</svg>
      </span>
      <span class="activity-text">${escapeHtml(a.text)}</span>
      <span class="activity-date">${escapeHtml(formatActivityDate(a.date))}</span>
    </li>`).join('');
}

// ═════════════════════════════════════════════
// 13) FooterStatusBar
// ═════════════════════════════════════════════
function setupFooterStatusBar() {
  $$('.footer-social').forEach(el => {
    el.addEventListener('click', () => {
      const link = el.dataset.link;
      if (link) window.electronAPI.openExternal(link);
    });
  });
  $('footer-link')?.addEventListener('click', () => {
    window.electronAPI.openExternal('https://t.me/LittleBitUA');
  });
  $('about-telegram')?.addEventListener('click', () => {
    window.electronAPI.openExternal('https://t.me/LittleBitUA');
  });
}

// ═════════════════════════════════════════════
// UPDATE CHECK (GitHub)
// ═════════════════════════════════════════════
async function checkForUpdates(userTriggered = false) {
  try {
    const r = await window.electronAPI.checkUpdate();
    if (!r) return;

    // Render dashboard card with version (only if defined)
    const numEl = $('dash-update-num');
    const tagEl = $('dash-update-tag');
    const dateEl = $('dash-update-date');
    const emptyEl = $('dash-update-empty');
    if (numEl && r.currentVersion) numEl.textContent = 'v' + r.currentVersion;

    if (r.hasUpdate) {
      if (tagEl)   { tagEl.textContent = t('dash.available'); tagEl.classList.add('available'); }
      if (dateEl)  {
        if (r.publishedAt) {
          const dateStr = new Date(r.publishedAt).toLocaleDateString(
            getCurrentLang() === 'uk' ? 'uk-UA' : 'en-US');
          dateEl.textContent = t('dash.released').replace('{date}', dateStr);
        } else { dateEl.textContent = ''; }
      }
      if (emptyEl) { emptyEl.textContent = t('dash.newVersionAvailable').replace('{v}', r.latestVersion); }
      window.__pendingUpdate = r;

      // Respect skip
      const saved = await window.electronAPI.settingsRead();
      if (saved.skippedUpdateVersion !== r.latestVersion) {
        showUpdateModal(r);
      }
    } else {
      if (tagEl)   { tagEl.textContent = t('dash.upToDate'); tagEl.classList.remove('available'); }
      if (dateEl)  dateEl.textContent = '';
      if (emptyEl) emptyEl.textContent = t('dash.launcherCurrent') + (userTriggered ? ' ✓' : '');
    }
  } catch { /* silent */ }
}

function showUpdateModal(r) {
  const overlay = $('update-overlay');
  if (!overlay) return;
  $('update-version').textContent =
    `Поточна: ${r.currentVersion} → Нова: ${r.latestVersion}`;
  $('update-release-name').textContent = r.name && r.name !== r.latestVersion ? r.name : '';
  $('update-body').innerHTML = r.body
    ? renderMarkdownLite(r.body)
    : '<em>No release notes.</em>';
  overlay.classList.remove('hidden');

  $('btn-update-skip').onclick = async () => {
    await persistSettings({ skippedUpdateVersion: r.latestVersion });
    overlay.classList.add('hidden');
  };
  $('btn-update-later').onclick    = () => overlay.classList.add('hidden');
  $('btn-update-download').onclick = async () => {
    overlay.classList.add('hidden');
    showToast(t('update.downloading') || 'Завантаження оновлення…', 'info', 5000);
    // Hand off to main process — it downloads, extracts, swaps files, restarts
    const res = await window.electronAPI.applyUpdate?.();
    if (!res?.success) {
      showToast((t('update.failed') || 'Помилка оновлення: ') + (res?.error || ''), 'error', 6000);
    }
    // If success → app.quit fires in main; nothing further to do here
  };
}

// Mirror update-progress events into the dashboard's UPDATE card
window.electronAPI.onUpdateProgress?.((msg) => {
  const progressBlock = $('dash-update-progress');
  const emptyEl       = $('dash-update-empty');
  const stage         = $('dash-update-stage');
  const fill          = $('dash-update-fill');
  const pctEl         = $('dash-update-pct');
  const size          = $('dash-update-size');
  const speed         = $('dash-update-speed');
  const time          = $('dash-update-time');
  const nameEl        = $('dash-update-name');

  if (progressBlock) progressBlock.hidden = false;
  if (emptyEl)       emptyEl.style.display = 'none';
  if (nameEl)        nameEl.textContent = msg.name || 'DP1 Launcher Update';

  if (msg.type === 'locating') {
    if (stage) stage.textContent = t('update.locating') || 'Знаходжу реліз…';
  } else if (msg.type === 'downloading') {
    const pct = msg.total > 0 ? (msg.downloaded / msg.total) * 100 : 0;
    if (fill)  fill.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = msg.total > 0 ? `${Math.round(pct)}%` : '—';
    if (stage) stage.textContent = t('update.downloading') || 'Завантаження…';
    if (size)  size.textContent  = `${formatBytes(msg.downloaded)} / ${msg.total > 0 ? formatBytes(msg.total) : '?'}`;
    if (speed) speed.textContent = `${formatBytes(msg.speed)}/s`;
    if (time && msg.speed > 0 && msg.total > 0) {
      time.textContent = formatSeconds((msg.total - msg.downloaded) / msg.speed);
    }
  } else if (msg.type === 'extracting') {
    if (stage) stage.textContent = t('update.extracting') || 'Розпакування…';
    if (fill)  fill.style.width = '100%';
  } else if (msg.type === 'installing') {
    if (stage) stage.textContent = t('update.installing') || 'Встановлення… лаунчер перезапуститься';
  } else if (msg.type === 'error') {
    if (stage) stage.textContent = (t('update.failed') || 'Помилка: ') + (msg.error || '');
  }
});

function renderMarkdownLite(md) {
  // Normalise CRLF → LF first so ^/$ anchors with the `m` flag work
  let s = escapeHtml(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Headings — order H3 → H2 → H1 so the hash count is consumed exactly
  s = s.replace(/^#{3}\s+(.+?)\s*$/gm, '<h3>$1</h3>');
  s = s.replace(/^#{2}\s+(.+?)\s*$/gm, '<h2>$1</h2>');
  s = s.replace(/^#{1}\s+(.+?)\s*$/gm, '<h1>$1</h1>');
  s = s.replace(/(?:^|\n)(?:[-*]\s+.+(?:\n|$))+/g, (block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean).map(it => `<li>${it}</li>`).join('');
    return `\n<ul>${items}</ul>`;
  });
  return s;
}

// ═════════════════════════════════════════════
// MISC
// ═════════════════════════════════════════════
function showToast(msg, type = 'info', dur = 3000) {
  const stack = $('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  stack.appendChild(el);
  const remove = () => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  const tid = setTimeout(remove, dur);
  el.addEventListener('click', () => { clearTimeout(tid); remove(); });
}

// Show the generic confirm modal. Returns a Promise<boolean>.
function openConfirm({ title, body, okText, cancelText, danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = $('confirm-overlay');
    const titleEl = $('confirm-title');
    const textEl  = $('confirm-text');
    const okBtn   = $('btn-confirm-ok');
    const noBtn   = $('btn-confirm-cancel');
    if (!overlay || !okBtn || !noBtn) { resolve(false); return; }

    if (title && titleEl) titleEl.textContent = title;
    if (textEl)           textEl.textContent  = body || '';
    if (okText)           okBtn.textContent   = okText;
    if (cancelText)       noBtn.textContent   = cancelText;
    okBtn.classList.toggle('btn-danger', !!danger);

    const cleanup = (val) => {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      noBtn.removeEventListener('click', onNo);
      overlay.removeEventListener('click', onBackdrop);
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onNo = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === overlay) cleanup(false); };

    okBtn.addEventListener('click', onOk);
    noBtn.addEventListener('click', onNo);
    overlay.addEventListener('click', onBackdrop);

    overlay.classList.remove('hidden');
  });
}

function setToggle(id, on) { const el = $(id); if (el) el.checked = !!on; }
function setRadio(name, val) { const el = document.querySelector(`input[name="${name}"][value="${val}"]`); if (el) el.checked = true; }
function getRadio(name)      { return document.querySelector(`input[name="${name}"]:checked`)?.value ?? ''; }

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ═════════════════════════════════════════════
// 19) Custom dropdowns (replace native <select> popups)
// ═════════════════════════════════════════════
function setupCustomSelects() {
  document.querySelectorAll('select.form-select').forEach(buildCustomSelect);

  // Close any open popups on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select.open').forEach(o => o.classList.remove('open'));
  });
}

function buildCustomSelect(select) {
  if (select.dataset.customWired === '1') return;
  if (select.disabled) return; // leave disabled ones as native (visually disabled is fine)

  const wrap = document.createElement('div');
  wrap.className = 'custom-select';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-select-btn';
  const label = document.createElement('span');
  label.className = 'cs-label';
  label.textContent = select.options[select.selectedIndex]?.text || '';
  btn.appendChild(label);
  const arrow = document.createElement('span');
  arrow.className = 'cs-arrow';
  arrow.innerHTML =
    '<svg viewBox="0 0 12 12" aria-hidden="true">' +
    '<path d="M2.5 4.5l3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.5" ' +
    'fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  btn.appendChild(arrow);
  wrap.appendChild(btn);

  const popup = document.createElement('div');
  popup.className = 'custom-select-popup';
  Array.from(select.options).forEach(opt => {
    const item = document.createElement('div');
    item.className = 'cs-option';
    item.dataset.value = opt.value;
    item.textContent = opt.text;
    if (opt.value === select.value) item.classList.add('active');
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      label.textContent = opt.text;
      popup.querySelectorAll('.cs-option').forEach(o =>
        o.classList.toggle('active', o.dataset.value === opt.value));
      wrap.classList.remove('open');
    });
    popup.appendChild(item);
  });
  wrap.appendChild(popup);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.custom-select.open').forEach(o => {
      if (o !== wrap) o.classList.remove('open');
    });
    wrap.classList.toggle('open');
  });
  popup.addEventListener('click', (e) => e.stopPropagation());

  // Sync if the underlying select changes programmatically
  select.addEventListener('change', () => {
    const txt = select.options[select.selectedIndex]?.text || '';
    label.textContent = txt;
    popup.querySelectorAll('.cs-option').forEach(o =>
      o.classList.toggle('active', o.dataset.value === select.value));
  });

  select.dataset.customWired = '1';
}

// ═════════════════════════════════════════════
// 14) TopNav view switching (HOME ↔ SETTINGS)
// ═════════════════════════════════════════════
function setupTopNavViews() {
  $$('.topnav-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view || 'home';
      switchView(view);
    });
  });
}

function switchView(view) {
  $$('.topnav-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'home' || view === 'settings' || view === 'map') {
    document.body.dataset.view = view;
  }
  if (view === 'map') setupMapView();
}

// ═════════════════════════════════════════════
// 14.5) Interactive Greenvale Map — pan + zoom + spoiler toggle
// ═════════════════════════════════════════════
const MAP_URLS = {
  clean:    'https://shshatteredmemories.com/greenvale/images/map/map_forweb_NO_SPOILERS.jpg',
  spoilers: 'https://shshatteredmemories.com/greenvale/images/map/map_forweb_SPOILERS.jpg',
};

const mapState = {
  initialised: false,
  scale: 1,
  tx:    0,
  ty:    0,
  minScale: 0.1,
  maxScale: 6,
  panning: false,
  panStartX: 0,
  panStartY: 0,
  txStart:   0,
  tyStart:   0,
  showSpoilers: false,
};

function setupMapView() {
  if (mapState.initialised) {
    // Re-fit on subsequent visits if the user resized the window.
    fitMapToStage();
    return;
  }
  mapState.initialised = true;

  const toggle = $('map-spoilers-toggle');
  if (toggle) {
    mapState.showSpoilers = !!toggle.checked;
    toggle.addEventListener('change', () => {
      mapState.showSpoilers = toggle.checked;
      loadMapImage();
    });
  }

  $('map-zoom-in') ?.addEventListener('click', () => zoomMap( 1.25));
  $('map-zoom-out')?.addEventListener('click', () => zoomMap(1 / 1.25));
  $('map-reset')   ?.addEventListener('click', fitMapToStage);

  const stage = $('map-stage');
  if (stage) {
    stage.addEventListener('mousedown', onMapMouseDown);
    stage.addEventListener('wheel',     onMapWheel, { passive: false });
  }
  window.addEventListener('mousemove', onMapMouseMove);
  window.addEventListener('mouseup',   onMapMouseUp);
  window.addEventListener('keydown', (e) => {
    if (document.body.dataset.view !== 'map') return;
    if (e.key === 'r' || e.key === 'R') fitMapToStage();
  });

  // Open the credit link in the user's default browser, not inside the app.
  $('map-credit-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.electronAPI.openExternal?.(e.currentTarget.href);
  });

  loadMapImage();
}

function loadMapImage() {
  const img    = $('map-img');
  const loader = $('map-loader');
  if (!img) return;

  if (loader) {
    loader.classList.remove('hidden', 'error');
    loader.textContent = t('map.loading');
  }
  img.style.visibility = 'hidden';

  const onLoad = () => {
    img.removeEventListener('load',  onLoad);
    img.removeEventListener('error', onErr);
    img.style.visibility = 'visible';
    if (loader) loader.classList.add('hidden');
    fitMapToStage();
  };
  const onErr = () => {
    img.removeEventListener('load',  onLoad);
    img.removeEventListener('error', onErr);
    if (loader) { loader.classList.add('error'); loader.textContent = t('map.error'); }
  };
  img.addEventListener('load',  onLoad);
  img.addEventListener('error', onErr);
  img.src = mapState.showSpoilers ? MAP_URLS.spoilers : MAP_URLS.clean;
}

function applyMapTransform() {
  const canvas = $('map-canvas');
  if (canvas) {
    canvas.style.transform = `translate(${mapState.tx}px, ${mapState.ty}px) scale(${mapState.scale})`;
  }
}

function fitMapToStage() {
  const stage = $('map-stage');
  const img   = $('map-img');
  if (!stage || !img || !img.naturalWidth) return;
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const scale = Math.min(sw / img.naturalWidth, sh / img.naturalHeight);
  mapState.scale = scale;
  mapState.tx = (sw - img.naturalWidth  * scale) / 2;
  mapState.ty = (sh - img.naturalHeight * scale) / 2;
  applyMapTransform();
}

function zoomMap(factor, centerX, centerY) {
  const stage = $('map-stage');
  if (!stage) return;
  const newScale = Math.min(mapState.maxScale, Math.max(mapState.minScale, mapState.scale * factor));
  if (newScale === mapState.scale) return;

  // Zoom around (centerX, centerY) in stage coords. Default to stage centre.
  const cx = centerX ?? stage.clientWidth  / 2;
  const cy = centerY ?? stage.clientHeight / 2;

  // World point under cursor before zoom
  const wx = (cx - mapState.tx) / mapState.scale;
  const wy = (cy - mapState.ty) / mapState.scale;

  mapState.scale = newScale;
  mapState.tx = cx - wx * newScale;
  mapState.ty = cy - wy * newScale;
  applyMapTransform();
}

function onMapMouseDown(e) {
  if (e.button !== 0) return;
  const stage = $('map-stage');
  if (!stage) return;
  mapState.panning = true;
  stage.classList.add('is-panning');
  mapState.panStartX = e.clientX;
  mapState.panStartY = e.clientY;
  mapState.txStart   = mapState.tx;
  mapState.tyStart   = mapState.ty;
  e.preventDefault();
}

function onMapMouseMove(e) {
  if (!mapState.panning) return;
  mapState.tx = mapState.txStart + (e.clientX - mapState.panStartX);
  mapState.ty = mapState.tyStart + (e.clientY - mapState.panStartY);
  applyMapTransform();
}

function onMapMouseUp() {
  if (!mapState.panning) return;
  mapState.panning = false;
  $('map-stage')?.classList.remove('is-panning');
}

function onMapWheel(e) {
  e.preventDefault();
  const stage = $('map-stage');
  if (!stage) return;
  const rect = stage.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomMap(factor, cx, cy);
}

// ═════════════════════════════════════════════
// 15) Topbar dropdowns (notifications + downloads)
// ═════════════════════════════════════════════
const notifState = { items: [] };
const downloadsState = { items: [] };

function setupTopBarDropdowns() {
  const closeAll = () => {
    $('notif-dropdown')?.classList.add('hidden');
    $('downloads-dropdown')?.classList.add('hidden');
  };

  // Re-target the bell button (override placeholder from setupTopNavigation)
  const bell = $('btn-notifications');
  if (bell) {
    bell.replaceWith(bell.cloneNode(true));
    $('btn-notifications')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const drop = $('notif-dropdown');
      const wasHidden = drop?.classList.contains('hidden');
      closeAll();
      if (wasHidden) drop?.classList.remove('hidden');
    });
  }

  const dl = $('btn-downloads');
  if (dl) {
    dl.replaceWith(dl.cloneNode(true));
    $('btn-downloads')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const drop = $('downloads-dropdown');
      const wasHidden = drop?.classList.contains('hidden');
      closeAll();
      if (wasHidden) drop?.classList.remove('hidden');
    });
  }

  $('btn-notif-clear')?.addEventListener('click', () => {
    notifState.items = [];
    renderNotifications();
    refreshNotifBadge();
  });

  // Outside-click closes
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.topnav-dropdown') &&
        !ev.target.closest('#btn-notifications') &&
        !ev.target.closest('#btn-downloads')) {
      closeAll();
    }
  });
}

function pushNotification(item) {
  notifState.items.unshift({
    id:    'n-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    title: item.title || '',
    desc:  item.desc  || '',
    kind:  item.kind  || 'info',
    onClick: item.onClick,
  });
  if (notifState.items.length > 12) notifState.items.length = 12;
  renderNotifications();
  refreshNotifBadge();
}

function renderNotifications() {
  const list = $('notif-list');
  if (!list) return;
  if (!notifState.items.length) {
    list.innerHTML = '<li class="dropdown-empty">No new notifications.</li>';
    return;
  }
  list.innerHTML = notifState.items.map(n => `
    <li class="dropdown-item" data-id="${n.id}">
      <span class="dropdown-item-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round">
          ${n.kind === 'update'    ? '<path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.7 1 6.3 2.7"/><path d="M21 3v6h-6"/>'
          : n.kind === 'setup'     ? '<path d="M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6z"/>'
          : n.kind === 'activity'  ? '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/>'
          : '<circle cx="12" cy="12" r="9"/><path d="M12 8h0M12 12v4"/>'}
        </svg>
      </span>
      <span class="dropdown-item-text">
        <span class="dropdown-item-title">${escapeHtml(n.title)}</span>
        <span class="dropdown-item-desc">${escapeHtml(n.desc)}</span>
      </span>
    </li>
  `).join('');

  list.querySelectorAll('.dropdown-item').forEach(li => {
    li.addEventListener('click', () => {
      const item = notifState.items.find(x => x.id === li.dataset.id);
      if (item?.onClick) item.onClick();
      $('notif-dropdown')?.classList.add('hidden');
    });
  });
}

function refreshNotifBadge() {
  const b = $('notif-badge');
  if (!b) return;
  if (notifState.items.length > 0) {
    b.textContent = String(notifState.items.length);
    b.style.display = '';
  } else {
    b.style.display = 'none';
  }
}

function setDownloadEntry(id, data) {
  let entry = downloadsState.items.find(x => x.id === id);
  if (!entry) {
    entry = { id, title: data.title || id, status: '', pct: 0 };
    downloadsState.items.push(entry);
  }
  Object.assign(entry, data);
  renderDownloads();
  refreshDownloadsMeta();
}
function clearDownload(id) {
  downloadsState.items = downloadsState.items.filter(x => x.id !== id);
  renderDownloads();
  refreshDownloadsMeta();
}
function renderDownloads() {
  const list = $('downloads-list');
  if (!list) return;
  if (!downloadsState.items.length) {
    list.innerHTML = '<li class="dropdown-empty">No active downloads.</li>';
    return;
  }
  list.innerHTML = downloadsState.items.map(d => `
    <li class="dropdown-item">
      <span class="dropdown-item-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/>
        </svg>
      </span>
      <span class="dropdown-item-text">
        <span class="dropdown-item-title">${escapeHtml(d.title)}</span>
        <span class="dropdown-item-desc">${escapeHtml(d.status || '')}</span>
        <span class="dropdown-item-bar"><div style="width: ${d.pct || 0}%"></div></span>
      </span>
    </li>
  `).join('');
}
function refreshDownloadsMeta() {
  const meta = $('downloads-meta');
  if (!meta) return;
  const n = downloadsState.items.length;
  meta.textContent = n > 0 ? `${n} active` : '0 Updates';
}

// ═════════════════════════════════════════════
// 16) First-run modal — folder + dpfix/4gb installer
// ═════════════════════════════════════════════
const firstRunState = { gameDir: null, exePath: null };

async function maybeShowFirstRun() {
  if (state.gamePath) return;       // already configured — nothing to do
  showFirstRunModal();
  pushNotification({
    kind: 'setup',
    title: 'Setup required',
    desc:  'Specify your game folder to continue.',
    onClick: showFirstRunModal,
  });
}

async function showFirstRunModal() {
  $('firstrun-overlay')?.classList.remove('hidden');
  await runAutodetect();
}
function hideFirstRunModal() { $('firstrun-overlay')?.classList.add('hidden'); }

async function runAutodetect() {
  const banner = $('firstrun-detect');
  if (!banner) return;
  banner.classList.add('hidden');
  try {
    const hit = await window.electronAPI.autodetectGame?.();
    if (!hit) return;
    $('firstrun-detect-path').textContent = hit.dir;
    banner.classList.remove('hidden');

    // One-click accept
    const btn = $('btn-firstrun-use-detected');
    if (btn) {
      btn.onclick = () => acceptDetected(hit);
    }
  } catch { /* silent */ }
}

function acceptDetected(hit) {
  firstRunState.gameDir = hit.dir;
  firstRunState.exePath = hit.exePath;
  const dirCard = document.querySelector('.firstrun-dir');
  dirCard?.classList.remove('error');
  dirCard?.classList.add('ok');
  $('firstrun-dir-path').textContent = hit.dir;
  $('firstrun-dir-hint').textContent =
    t('fr.exeFound').replace('{name}', hit.exePath.split(/[\\/]/).pop());
  $('btn-firstrun-install').disabled = false;
}

function setupFirstRunModal() {
  $('btn-firstrun-pick')?.addEventListener('click', async () => {
    const r = await window.electronAPI.pickGameDir();
    if (!r) return;
    const dirCard = document.querySelector('.firstrun-dir');
    $('firstrun-dir-path').textContent = r.dir;
    if (r.valid) {
      dirCard?.classList.remove('error'); dirCard?.classList.add('ok');
      $('firstrun-dir-hint').textContent =
        t('fr.exeFound').replace('{name}', r.exePath.split(/[\\/]/).pop());
      $('btn-firstrun-install').disabled = false;
      firstRunState.gameDir = r.dir;
      firstRunState.exePath = r.exePath;
    } else {
      dirCard?.classList.remove('ok'); dirCard?.classList.add('error');
      $('firstrun-dir-hint').textContent = t('fr.exeMissing');
      $('btn-firstrun-install').disabled = true;
    }
  });

  $('btn-firstrun-install')?.addEventListener('click', runFirstRunInstall);
  $('btn-firstrun-back')?.addEventListener('click',    () => setFirstRunStep(1));
  $('btn-firstrun-next-3')?.addEventListener('click',  () => setFirstRunStep(3));
  $('btn-firstrun-finish')?.addEventListener('click',  () => {
    hideFirstRunModal();
    autoFindIni();
    onGamePathChanged();
  });

  $('btn-apply-4gb')?.addEventListener('click',  applyPatch4GB);
  $('btn-apply-dxvk')?.addEventListener('click', applyPatchDXVK);

  // v1.4 preset picker
  $('btn-firstrun-apply-preset')?.addEventListener('click', onFirstRunApplyPreset);
  $('btn-firstrun-skip')?.addEventListener('click', () => setFirstRunStep(3));

  // Subscribe to setup-progress events (also feeds dashboard UPDATE card)
  window.electronAPI.onSetupProgress?.((msg) => {
    updateFirstRunComponent(msg);
    updateDashboardDownload(msg);
  });
}

function setFirstRunStep(n) {
  const ov = $('firstrun-overlay');
  if (!ov) return;
  ov.dataset.step = String(n);
  // Update step bubbles
  const bubbles = ov.querySelectorAll('.step-bubble');
  bubbles.forEach((b) => {
    const num = parseInt(b.dataset.step, 10);
    b.classList.toggle('active', num === n);
    b.classList.toggle('done',   num <  n);
  });
  // Update step connectors
  const links = ov.querySelectorAll('.step-link');
  links.forEach((l, idx) => l.classList.toggle('done', idx + 1 < n));

  // v1.4 — when entering step 2, refresh RAM-aware 4GB visibility
  if (n === 2) refreshFirstRun4gbVisibility();
}

async function refreshFirstRun4gbVisibility() {
  const extra4gb = $('extra-4gb');
  const status   = $('opt-4gb-status');
  const check    = $('opt-4gb');
  if (!extra4gb) return;
  try {
    const info = await window.electronAPI.systemInfo?.();
    const ramGB = info?.totalMemoryGB || 0;
    // Show only if RAM > 4 GB (recommended target for 4GB patch)
    if (ramGB > 4) {
      extra4gb.style.display = '';
      if (status) {
        status.textContent = `${t('fr.systemRam') || 'System RAM'}: ${ramGB} GB — ${t('fr.patch4gbRecommended') || '4GB Patch recommended'}`;
      }
      if (check) check.checked = true;
    } else {
      extra4gb.style.display = 'none';
      if (check) check.checked = false;
    }
  } catch {
    // If RAM check fails, just show by default (safer)
    extra4gb.style.display = '';
  }
}

async function onFirstRunApplyPreset() {
  const gameDir = firstRunState.gameDir;
  if (!gameDir) return;
  const selected = document.querySelector('input[name="firstrun-preset"]:checked')?.value || 'dpfix-dxvk';
  const with4gb  = $('opt-4gb')?.checked || false;

  const statusEl = $('firstrun-preset-status');
  const applyBtn = $('btn-firstrun-apply-preset');
  if (applyBtn) applyBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = t('fr.applyingPreset') || 'Applying preset...';
    statusEl.className = 'firstrun-preset-status active';
  }

  try {
    const r = await window.electronAPI.applyPreset?.(gameDir, selected, with4gb);
    if (r?.success) {
      if (statusEl) {
        statusEl.textContent = (r.steps || []).join('\n');
        statusEl.className = 'firstrun-preset-status active ok';
      }
      logActivity('completed', `Preset applied: ${selected}${with4gb ? ' + 4GB' : ''}`);
      showToast((t('fr.presetApplied') || 'Preset applied') + `: ${selected}`, 'success');
      // Auto-advance to step 3 after a brief delay so user sees the result
      setTimeout(() => setFirstRunStep(3), 1200);
    } else if (r?.needsAdmin) {
      if (applyBtn) applyBtn.disabled = false;
      await handleNeedsAdmin(r.alternative || 'dxvk-only', statusEl);
    } else {
      if (statusEl) {
        statusEl.textContent = ((r?.steps || []).join('\n') + '\n' + (r?.error || 'failed')).trim();
        statusEl.className = 'firstrun-preset-status active error';
      }
      showToast((t('fr.presetError') || 'Preset error: ') + (r?.error || ''), 'error');
      if (applyBtn) applyBtn.disabled = false;
    }
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = err.message;
      statusEl.className = 'firstrun-preset-status active error';
    }
    if (applyBtn) applyBtn.disabled = false;
  }
}

async function applyPatch4GB() {
  const card = $('patch-4gb');
  const status = $('patch-4gb-status');
  const btn = $('btn-apply-4gb');
  if (!firstRunState.gameDir || !firstRunState.exePath) return;

  card.classList.remove('done', 'error'); card.classList.add('working');
  status.textContent = t('fr.running4gb');
  btn.disabled = true;

  const r = await window.electronAPI.apply4gbAuto(firstRunState.gameDir, firstRunState.exePath);
  if (r?.success) {
    card.classList.remove('working'); card.classList.add('done');
    status.textContent = t('fr.done4gb') + firstRunState.exePath.split(/[\\/]/).pop();
    btn.textContent = t('fr.doneBtn');
    logActivity('completed', '4GB Patch applied');
  } else {
    card.classList.remove('working'); card.classList.add('error');
    status.textContent = t('fr.statusError') + (r?.error || 'unknown');
    btn.disabled = false;
  }
}

async function applyPatchDXVK() {
  const card = $('patch-dxvk');
  const status = $('patch-dxvk-status');
  const btn = $('btn-apply-dxvk');
  if (!firstRunState.gameDir) return;

  card.classList.remove('done', 'error'); card.classList.add('working');
  status.textContent = t('fr.copyingDxvk');
  btn.disabled = true;

  const r = await window.electronAPI.applyDxvkAuto(firstRunState.gameDir);
  if (r?.success) {
    card.classList.remove('working'); card.classList.add('done');
    status.textContent = t('fr.doneDxvk').replace('{count}', r.replacements ?? '?');
    btn.textContent = t('fr.doneBtn');
    logActivity('completed', 'DXVK applied');
  } else {
    card.classList.remove('working'); card.classList.add('error');
    status.textContent = t('fr.statusError') + (r?.error || 'unknown');
    btn.disabled = false;
  }
}

async function runFirstRunInstall() {
  if (!firstRunState.gameDir) return;

  // Persist gamePath before install (so other features can use it)
  state.gamePath = firstRunState.exePath;
  await persistSettings({ gamePath: firstRunState.exePath });
  const gp = $('game-path');
  if (gp) gp.value = firstRunState.exePath;

  // gamePath just landed — kick the gamePath-changed hook so the autosave
  // worker actually starts. Without this the worker stays dead on first-run.
  await onGamePathChanged();

  // Lock UI
  $('btn-firstrun-install').disabled = true;
  $('btn-firstrun-pick').disabled    = true;

  setDownloadEntry('setup', { title: 'Components install', status: 'Starting…', pct: 0 });

  const results = await window.electronAPI.setupInstallAll(firstRunState.gameDir);

  const allOk = Object.values(results).every(r => r.success);
  if (allOk) {
    logActivity('info', 'Components installed (DPFix + 4GB + DXVK)');
    pushNotification({ kind: 'info', title: 'Components installed',
                       desc: 'DPFix, 4GB Patch and DXVK cache are downloaded.' });
    // Move to Step 2 — optional patches
    setTimeout(() => setFirstRunStep(2), 800);
  } else {
    $('btn-firstrun-pick').disabled = false;
    $('btn-firstrun-install').disabled = false;
    showToast('Деякі компоненти не встановлено. Спробуйте ще раз.', 'warn');
  }

  setTimeout(() => clearDownload('setup'), 3000);
}

function updateFirstRunComponent(msg) {
  const map = { 'dpfix': 'frc-dpfix', '4gb': 'frc-4gb', 'dxvk': 'frc-dxvk' };
  const el = $(map[msg.id]);
  if (!el) return;
  const statusEl = el.querySelector('.firstrun-comp-status');
  const fillEl   = el.querySelector('.firstrun-comp-fill');

  el.classList.remove('downloading', 'extracting', 'done', 'error');
  switch (msg.type) {
    case 'downloading': {
      el.classList.add('downloading');
      const pct = msg.total > 0 ? (msg.downloaded / msg.total) * 100 : 0;
      if (fillEl)   fillEl.style.width = `${pct.toFixed(1)}%`;
      if (statusEl) statusEl.textContent =
        `${formatBytes(msg.downloaded)} / ${msg.total > 0 ? formatBytes(msg.total) : '?'} · ${formatBytes(msg.speed)}/s`;
      break;
    }
    case 'extracting':
      el.classList.add('downloading');
      if (fillEl)   fillEl.style.width = '100%';
      if (statusEl) statusEl.textContent = t('fr.statusExtracting');
      break;
    case 'skipped':
      el.classList.add('done');
      if (fillEl)   fillEl.style.width = '100%';
      if (statusEl) statusEl.textContent = t('fr.statusInstalled');
      break;
    case 'done':
      el.classList.add('done');
      if (fillEl)   fillEl.style.width = '100%';
      if (statusEl) statusEl.textContent = t('fr.statusDone');
      break;
    case 'error':
      el.classList.add('error');
      if (statusEl) statusEl.textContent = t('fr.statusError') + (msg.error || '');
      break;
  }
}

function updateDashboardDownload(msg) {
  const progressBlock = $('dash-update-progress');
  const emptyEl       = $('dash-update-empty');
  if (progressBlock) progressBlock.hidden = false;
  if (emptyEl)       emptyEl.style.display = 'none';

  const compNames = { 'dpfix': 'DPFix v0.9.5', '4gb': '4GB LAA Patch', 'dxvk': 'DXVK v2.7.1' };
  $('dash-update-name').textContent = compNames[msg.id] || msg.id;

  const fill  = $('dash-update-fill');
  const pctEl = $('dash-update-pct');
  const stage = $('dash-update-stage');
  const size  = $('dash-update-size');
  const speed = $('dash-update-speed');
  const time  = $('dash-update-time');

  if (msg.type === 'downloading') {
    const pct = msg.total > 0 ? (msg.downloaded / msg.total) * 100 : 0;
    if (fill)  fill.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = msg.total > 0 ? `${Math.round(pct)}%` : '—';
    if (stage) stage.textContent = 'Downloading…';
    if (size)  size.textContent  = `${formatBytes(msg.downloaded)} / ${msg.total > 0 ? formatBytes(msg.total) : '?'}`;
    if (speed) speed.textContent = `${formatBytes(msg.speed)}/s`;
    if (time && msg.speed > 0 && msg.total > 0) {
      const remaining = (msg.total - msg.downloaded) / msg.speed;
      time.textContent = formatSeconds(remaining);
    }
  } else if (msg.type === 'extracting') {
    if (stage) stage.textContent = 'Extracting files…';
    if (fill)  fill.style.width = '100%';
    if (pctEl) pctEl.textContent = '—';
  } else if (msg.type === 'done') {
    if (stage) stage.textContent = '✓ Installed';
    if (fill)  fill.style.width = '100%';
    if (pctEl) pctEl.textContent = '100%';
  } else if (msg.type === 'error') {
    if (stage) stage.textContent = 'Error: ' + (msg.error || '');
  }

  if (msg.type === 'skipped') {
    if (stage) stage.textContent = '✓ Already installed';
    if (fill)  fill.style.width = '100%';
    if (pctEl) pctEl.textContent = '✓';
  }

  // Mirror to topnav Downloads dropdown
  setDownloadEntry(msg.id, {
    title:  compNames[msg.id] || msg.id,
    status: msg.type === 'downloading'
      ? `${msg.total > 0 ? Math.round(msg.downloaded / msg.total * 100) : 0}% · ${formatBytes(msg.speed || 0)}/s`
      : (msg.type === 'extracting' ? 'Extracting…'
      :  msg.type === 'done'        ? 'Done ✓'
      :  msg.type === 'error'       ? 'Error' : ''),
    pct:    msg.type === 'done' ? 100
         : (msg.total > 0 ? Math.round(msg.downloaded / msg.total * 100) : 0),
  });
  if (msg.type === 'done' || msg.type === 'error') {
    setTimeout(() => clearDownload(msg.id), 4000);
  }
}

function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  if (n < 1024)       return `${n.toFixed(0)} B`;
  if (n < 1048576)    return `${(n/1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n/1048576).toFixed(1)} MB`;
  return `${(n/1073741824).toFixed(2)} GB`;
}
function formatSeconds(s) {
  if (!isFinite(s) || s < 0) return '—';
  const total = Math.round(s);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// ═════════════════════════════════════════════
// 17) Audio + Controls + Interface controls (persisted)
// ═════════════════════════════════════════════
function setupAudioInterfaceControls() {
  // Read saved prefs
  loadUiPrefs();

  // Save on change for the simple toggles + selects
  const persistedFields = ['opt-steam-overlay', 'opt-run-as-admin'];
  persistedFields.forEach(id => {
    const el = $(id);
    if (!el) return;
    const ev = el.type === 'checkbox' ? 'change' : (el.tagName === 'SELECT' ? 'change' : 'input');
    el.addEventListener(ev, () => saveUiPrefs());
  });

  // Steam Overlay — functional: edits Steam userdata/<id>/config/localconfig.vdf
  $('opt-steam-overlay')?.addEventListener('change', async (ev) => {
    const enabled = ev.target.checked;
    const r = await window.electronAPI.setSteamOverlay(STEAM_APPID, enabled);
    if (r?.success) {
      showToast(
        enabled ? 'Steam Overlay увімкнено для DP ✓' : 'Steam Overlay вимкнено для DP ✓',
        'success'
      );
      if (r.note) showToast(r.note, 'info', 5000);
      logActivity('completed', `Steam Overlay → ${enabled ? 'on' : 'off'}`);
    } else {
      ev.target.checked = !enabled; // revert
      const fails = (r?.failures && r.failures.length) ? ` (${r.failures[0]})` : '';
      showToast('Не вдалося змінити Steam Overlay: ' + (r?.error || 'unknown') + fails, 'error');
    }
  });
}

async function loadUiPrefs() {
  try {
    const saved = await window.electronAPI.settingsRead();
    const prefs = saved.uiPrefs || {};
    const apply = (id, key, isCheckbox) => {
      const el = $(id);
      if (!el || prefs[key] === undefined) return;
      if (isCheckbox) el.checked = !!prefs[key];
      else            el.value   = String(prefs[key]);
      el.dispatchEvent(new Event('input'));
    };
    apply('opt-steam-overlay',     'steamOverlay',     true);
    apply('opt-run-as-admin',      'runAsAdmin',       true);
  } catch { /* none */ }
}
async function saveUiPrefs() {
  const val = (id) => $(id)?.value;
  const chk = (id) => !!$(id)?.checked;
  const prefs = {
    steamOverlay: chk('opt-steam-overlay'),
    runAsAdmin:   chk('opt-run-as-admin'),
  };
  await persistSettings({ uiPrefs: prefs });
}

// ═════════════════════════════════════════════
// 18) App version + activity log
// ═════════════════════════════════════════════
async function loadAppVersion() {
  try {
    const v = await window.electronAPI.getAppVersion?.();
    if (!v) return;
    const tag = 'v' + v;
    const heroV  = $('hero-version');
    const dashV  = $('dash-update-num');
    const aboutV = document.querySelector('.about-version');
    if (heroV)  heroV.textContent  = tag;
    if (dashV)  dashV.textContent  = tag;
    if (aboutV) aboutV.textContent = tag;
  } catch {}
}

async function logActivity(kind, text) {
  try { await window.electronAPI.activityLog?.({ kind, text }); }
  catch {}
  // Also refresh dashboard activity list
  setTimeout(renderActivity, 100);
}

// ═════════════════════════════════════════════════════════════════════════════
// v1.4.0 STABILITY / DIAGNOSTICS / COMPATIBILITY (UI handlers)
// ═════════════════════════════════════════════════════════════════════════════

async function refreshStabilityMode() {
  const statusEl = $('stability-mode-status');
  const applyBtn = $('btn-stability-apply');
  const revertBtn = $('btn-stability-revert');
  const note = $('stability-mode-note');
  const gameDir = getGameDir();
  if (!gameDir) {
    if (statusEl) statusEl.textContent = t('stability.noGame') || 'Set game path first';
    if (applyBtn) applyBtn.disabled = true;
    if (revertBtn) revertBtn.disabled = true;
    return;
  }
  try {
    const r = await window.electronAPI.stabilityModeStatus?.(gameDir);
    if (!r) return;
    if (r.enabled) {
      if (statusEl) {
        statusEl.textContent = t('stability.statusApplied') || '✓ Applied';
        statusEl.className = 'compat-status ok';
      }
      if (applyBtn) applyBtn.disabled = true;
      if (revertBtn) revertBtn.disabled = false;
    } else {
      if (statusEl) {
        statusEl.textContent = t('stability.statusNotApplied') || '— Not applied';
        statusEl.className = 'compat-status';
      }
      if (applyBtn) applyBtn.disabled = false;
      if (revertBtn) revertBtn.disabled = true;
    }
    // Component breakdown
    if (note && r.components) {
      const checks = [];
      checks.push(`${r.components.crashDump ? '✓' : '✗'} crash dumps`);
      checks.push(`${r.components.fpsCapDxvk ? '✓' : '✗'} FPS cap 60`);
      checks.push(`${r.components.dpfixBorderless ? '✓' : '✗'} DPfix borderless`);
      note.textContent = checks.join(' · ');
      note.className = 'compat-note';
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onStabilityApply() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const ok = await openConfirm({
    title: t('stability.confirmApplyTitle') || 'Apply Recommended Stability Mode?',
    body:  t('stability.confirmApplyBody')  ||
           'Launcher will: enable crash dump collection (HKCU), set DXVK FPS cap=60, ' +
           'apply DPfix borderless/windowed-safe defaults (with backup). DPfix.ini will be ' +
           'backed up to .stability-mode.bak. No DP.exe modification.',
    okText: t('stability.applyBtn') || 'Apply',
    cancelText: t('skipIntro.confirmCancel') || 'Cancel',
  });
  if (!ok) return;
  const btn = $('btn-stability-apply');
  const note = $('stability-mode-note');
  if (btn) btn.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.stabilityModeApply?.(gameDir);
    if (r?.success) {
      if (note) {
        note.textContent = (r.steps || []).join(' · ');
        note.className = 'compat-note ok';
      }
      showToast(t('toast.stabilityApplied') || 'Stability mode applied ✓', 'success');
      logActivity('completed', 'Recommended Stability Mode applied');
      refreshStabilityMode();
      refreshCrashdumpStatus();
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
      showToast((t('toast.stabilityErr') || 'Error: ') + (r?.error || ''), 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function onStabilityRevert() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const ok = await openConfirm({
    title: t('stability.confirmRevertTitle') || 'Revert Stability Mode?',
    body:  t('stability.confirmRevertBody')  || 'Restore previous DPfix.ini / dxvk.conf state and remove crash-dump registry keys (if added by this mode).',
    okText: t('stability.revertBtn') || 'Revert',
    cancelText: t('skipIntro.confirmCancel') || 'Cancel',
  });
  if (!ok) return;
  const btn = $('btn-stability-revert');
  const note = $('stability-mode-note');
  if (btn) btn.disabled = true;
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.stabilityModeRevert?.(gameDir);
    if (r?.success) {
      if (note) {
        note.textContent = (r.steps || []).join(' · ');
        note.className = 'compat-note ok';
      }
      showToast(t('toast.stabilityReverted') || 'Stability mode reverted ✓', 'success');
      logActivity('info', 'Recommended Stability Mode reverted');
      refreshStabilityMode();
      refreshCrashdumpStatus();
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshCrashdumpStatus() {
  const badge = $('crashdump-badge');
  const note = $('crashdump-note');
  try {
    const r = await window.electronAPI.crashdumpStatus?.();
    if (badge) {
      if (r?.enabled) {
        badge.textContent = `✓ ${t('saves.on') || 'On'}`;
        badge.className = 'fix-item-badge ok';
      } else {
        badge.textContent = `— ${t('saves.off') || 'Off'}`;
        badge.className = 'fix-item-badge';
      }
    }
    if (note && r?.enabled) {
      note.textContent = `Folder: ${r.folder || '?'} · DumpType=${r.type ?? '?'} · DumpCount=${r.count ?? '?'}`;
      note.className = 'compat-note';
    } else if (note) {
      note.textContent = '';
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onCrashdumpEnable() {
  const note = $('crashdump-note');
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.crashdumpEnable?.();
    if (r?.success) {
      if (note) {
        note.textContent = (r.steps || []).join(' · ');
        note.className = 'compat-note ok';
      }
      showToast(t('toast.crashdumpOn') || 'Crash dumps enabled ✓', 'success');
      refreshCrashdumpStatus();
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onCrashdumpDisable() {
  const note = $('crashdump-note');
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.crashdumpDisable?.();
    if (r?.success) {
      if (note) { note.textContent = t('crashdump.disabled') || 'Disabled'; note.className = 'compat-note'; }
      showToast(t('toast.crashdumpOff') || 'Crash dumps disabled', 'success');
      refreshCrashdumpStatus();
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onCrashdumpOpen() {
  try {
    const r = await window.electronAPI.crashdumpOpenFolder?.();
    if (!r?.success) showToast(t('toast.crashdumpOpenErr') || 'Could not open folder', 'error');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onCrashdumpCopy() {
  try {
    const r = await window.electronAPI.crashdumpCopyInstructions?.();
    if (r?.success) {
      showToast(t('toast.crashdumpCopied') || `Template copied to clipboard (${r.length} chars)`, 'success');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onMediaScan() {
  const note = $('media-note');
  const result = $('media-result');
  const badge = $('media-badge');
  if (note) { note.textContent = t('media.scanning') || 'Scanning...'; note.className = 'compat-note'; }
  if (result) result.innerHTML = '';
  try {
    const r = await window.electronAPI.mediaCheck?.();
    if (!r) return;
    const items = [];
    if (r.installed?.length) {
      items.push(`<div><strong>${t('media.installedPacks') || 'Installed codec packs'}:</strong></div>`);
      r.installed.forEach(p => {
        items.push(`<div>⚠ ${p.name}: ${p.displayName}</div>`);
      });
    }
    if (r.lavModules?.length) {
      items.push(`<div><strong>${t('media.lavModules') || 'LAV modules on disk'}:</strong></div>`);
      r.lavModules.forEach(m => {
        items.push(`<div>⚠ ${m}</div>`);
      });
    }
    if (!r.installed?.length && !r.lavModules?.length) {
      items.push(`<div>✓ ${t('media.clean') || 'No codec packs / LAV modules detected'}</div>`);
    }
    if (result) result.innerHTML = items.join('');
    if (badge) {
      badge.textContent = r.risky ? '⚠' : '✓';
      badge.className = r.risky ? 'fix-item-badge warn' : 'fix-item-badge ok';
    }
    if (note) {
      note.textContent = r.risky
        ? (t('media.warnText') || 'Codec packs detected — may interfere with WMV cutscenes')
        : (t('media.cleanText') || 'No risky codec stack detected');
      note.className = r.risky ? 'compat-note warn' : 'compat-note ok';
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onMediaTest() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const note = $('media-note');
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.mediaTestPlayback?.(gameDir);
    if (r?.success) {
      if (note) {
        note.textContent = `${t('media.tested') || 'Opened with system default'}: ${r.file} (${r.sizeKB} KB)`;
        note.className = 'compat-note ok';
      }
    } else {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function refreshPhysxStatus() {
  const badge = $('physx-badge');
  const note = $('physx-note');
  try {
    const r = await window.electronAPI.physxCheck?.();
    if (badge) {
      if (r?.installed) {
        badge.textContent = `✓ ${r.version || 'installed'}`;
        badge.className = 'fix-item-badge ok';
      } else {
        badge.textContent = '⚠ missing';
        badge.className = 'fix-item-badge warn';
      }
    }
    if (note) {
      if (r?.installed) {
        note.textContent = `${t('physx.found') || 'Installed'}: ${r.version || '?'}${r.location ? ` · ${r.location}` : ''}`;
        note.className = 'compat-note ok';
      } else {
        note.textContent = t('physx.missing') || 'NVIDIA PhysX legacy runtime not detected — game may not start';
        note.className = 'compat-note warn';
      }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onPhysxDownload() {
  // Open NVIDIA PhysX legacy download page (community-known good version)
  try {
    await window.electronAPI.openExternal?.('https://www.nvidia.com/en-us/drivers/physx/physx-9-13-0725-driver/');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function onXidiCheck() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const note = $('xidi-note');
  const badge = $('xidi-badge');
  try {
    const r = await window.electronAPI.xidiCheckInstalled?.(gameDir);
    if (badge) {
      if (r?.installed) {
        badge.textContent = `✓ ${t('xidi.installed') || 'installed'}`;
        badge.className = 'fix-item-badge ok';
      } else {
        badge.textContent = '—';
        badge.className = 'fix-item-badge';
      }
    }
    if (note) {
      const lines = [];
      if (r?.installed) lines.push(`✓ ${t('xidi.installedFull') || 'Xidi appears to be installed (Xidi.ini found)'}`);
      else lines.push(t('xidi.notInstalled') || 'Xidi is not installed in game folder');
      if (r?.files?.length) {
        lines.push((t('xidi.foundFiles') || 'Files in game folder') + ':');
        r.files.forEach(f => lines.push(`  · ${f.name} (${f.sizeKB} KB)`));
      }
      note.textContent = lines.join('\n');
      note.className = 'compat-note';
      note.style.whiteSpace = 'pre-line';
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onXidiOpen() {
  try { await window.electronAPI.xidiOpenPage?.(); }
  catch (err) { showToast(err.message, 'error'); }
}

async function onDiagExport() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const note = $('diag-export-note');
  const btn = $('btn-diag-export');
  if (btn) btn.disabled = true;
  if (note) { note.textContent = t('diagExport.generating') || 'Building diagnostic package...'; note.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.diagnosticExport?.(gameDir);
    if (r?.success) {
      if (note) {
        note.textContent = `${t('diagExport.success') || 'Saved'}: ${r.outputPath} (${Math.round(r.size / 1024)} KB)`;
        note.className = 'compat-note ok';
      }
      showToast(t('toast.diagExportOk') || 'Diagnostic package exported ✓', 'success');
      logActivity('completed', `Diagnostic package: ${r.outputPath}`);
    } else if (r?.error !== 'User cancelled') {
      if (note) { note.textContent = r?.error || 'failed'; note.className = 'compat-note error'; }
    } else {
      if (note) { note.textContent = ''; note.className = 'compat-note'; }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function detectCurrentPreset() {
  const note = $('settings-preset-status');
  const gameDir = getGameDir();
  if (!gameDir) {
    if (note) { note.textContent = t('stability.noGame') || 'Set game path first'; note.className = 'compat-note'; }
    return;
  }
  try {
    const r = await window.electronAPI.checkDxvkApplied?.(gameDir);
    let detected = 'unknown';
    if (r?.systemDll && r?.gamePatched) detected = 'dpfix-dxvk';
    // For dxvk-only vs dpfix-only we can't perfectly distinguish without
    // reading d3d9.dll bytes, but if systemDll absent → likely dpfix-only
    else if (!r?.systemDll && r?.gamePatched) detected = 'dpfix-only';
    else if (r?.systemDll && !r?.gamePatched) detected = 'dxvk-only';
    else detected = 'dpfix-only';
    // Select the matching radio
    const radio = document.querySelector(`input[name="settings-preset"][value="${detected}"]`);
    if (radio) radio.checked = true;
    if (note) {
      note.textContent = `${t('presetsTab.current') || 'Current'}: ${detected}`;
      note.className = 'compat-note ok';
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onSettingsApplyPreset() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const selected = document.querySelector('input[name="settings-preset"]:checked')?.value;
  if (!selected) return;

  const ok = await openConfirm({
    title: t('presetsTab.confirmTitle') || `Apply ${selected}?`,
    body:  t('presetsTab.confirmBody')  ||
           'Launcher will reconfigure the d3d9.dll chain accordingly. DXVK presets need admin (write to SysWOW64).',
    okText: t('presetsTab.applyBtn') || 'Apply',
    cancelText: t('skipIntro.confirmCancel') || 'Cancel',
  });
  if (!ok) return;

  const note = $('settings-preset-status');
  if (note) { note.textContent = '...'; note.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.applyPreset?.(gameDir, selected, false);
    if (r?.success) {
      if (note) {
        note.textContent = (r.steps || []).join(' · ');
        note.className = 'compat-note ok';
      }
      showToast((t('toast.presetApplied') || 'Preset applied') + `: ${selected}`, 'success');
      logActivity('completed', `Preset applied via Settings: ${selected}`);
    } else if (r?.needsAdmin) {
      await handleNeedsAdmin(r.alternative || 'dxvk-only', note);
    } else {
      if (note) {
        note.textContent = ((r?.steps || []).join(' · ') + ' · ' + (r?.error || 'failed')).trim();
        note.className = 'compat-note error';
      }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

// v1.5.1: Offer the user a path forward when a preset needs SysWOW64 write
// access but the launcher isn't elevated. Two options: relaunch as admin (UAC
// prompt) or auto-fall back to the no-admin alternative (DXVK-only).
async function handleNeedsAdmin(alternative, noteEl) {
  const choice = await openConfirm({
    title: t('admin.confirmTitle') || 'Adminstrator rights required',
    body:  t('admin.confirmBody')  ||
           'DPfix + DXVK preset writes a DLL to C:\\Windows\\SysWOW64, which requires Administrator. ' +
           'Click OK to relaunch the launcher elevated (UAC prompt) and continue. ' +
           'Cancel to fall back to the "DXVK only" preset instead, which writes only into the game folder (no admin).',
    okText: t('admin.relaunchBtn') || 'Relaunch as Administrator',
    cancelText: t('admin.fallbackBtn') || 'Use DXVK only',
  });
  if (choice) {
    if (noteEl) { noteEl.textContent = t('admin.relaunching') || 'Relaunching elevated…'; noteEl.className = 'compat-note'; }
    try {
      const r = await window.electronAPI.relaunchAsAdmin?.();
      // Handler returns { accepted: true/false } — on accepted, app quits
      // immediately so this assignment never reaches the user. On declined
      // we drop back to the regular UI.
      const ok = r?.accepted === true || r?.ok === true;
      if (!ok && noteEl) {
        noteEl.textContent = r?.error || (t('admin.relaunchDeclined') || t('admin.relaunchFailed') || 'UAC declined.');
        noteEl.className = 'compat-note error';
      }
    } catch (err) {
      if (noteEl) { noteEl.textContent = err.message; noteEl.className = 'compat-note error'; }
    }
    return;
  }
  // Fallback path
  const gameDir = getGameDir();
  if (noteEl) { noteEl.textContent = t('admin.fallingBack') || 'Falling back to DXVK only…'; noteEl.className = 'compat-note'; }
  try {
    const r = await window.electronAPI.applyPreset?.(gameDir, alternative, false);
    if (r?.success) {
      if (noteEl) {
        noteEl.textContent = (r.steps || []).join(' · ');
        noteEl.className = 'compat-note ok';
      }
      showToast((t('toast.presetApplied') || 'Preset applied') + `: ${alternative}`, 'success');
      logActivity('completed', `Preset fallback applied: ${alternative}`);
    } else if (noteEl) {
      noteEl.textContent = ((r?.steps || []).join(' · ') + ' · ' + (r?.error || 'failed')).trim();
      noteEl.className = 'compat-note error';
    }
  } catch (err) {
    if (noteEl) { noteEl.textContent = err.message; noteEl.className = 'compat-note error'; }
  }
}

// ─── v1.5.0: NaN Hang Guard (experimental DP.exe patch) ───────────────────────
function nanGuardStatusLabel(status) {
  switch (status) {
    case 'applied':      return t('nanGuard.statusApplied')      || '✓ Applied';
    case 'found':        return t('nanGuard.statusFound')        || '⚙ Ready (not applied)';
    case 'no-pattern':   return t('nanGuard.statusNoPattern')    || '? Pattern not found';
    case 'ambiguous':    return t('nanGuard.statusAmbiguous')    || '⚠ Ambiguous match';
    case 'no-exe':       return t('nanGuard.statusNoExe')        || '— DP.exe not found';
    case 'no-game':      return t('nanGuard.statusNoGame')       || '— Set game path first';
    case 'not-pe':       return t('nanGuard.statusNotPe')        || '⚠ Not a valid PE';
    case 'game-running': return t('nanGuard.statusGameRunning')  || '⏸ Close game first';
    case 'verify-failed':return t('nanGuard.statusVerifyFailed') || '⚠ Byte verify failed';
    default:             return status || '?';
  }
}

function nanGuardBadgeClass(status) {
  if (status === 'applied') return 'fix-item-badge ok';
  if (status === 'found')   return 'fix-item-badge';
  return 'fix-item-badge warn';
}

async function refreshNanGuardStatus() {
  const badge   = $('nanguard-badge');
  const note    = $('nanguard-note');
  const applyBtn  = $('btn-nanguard-apply');
  const revertBtn = $('btn-nanguard-revert');
  const diagWrap  = $('nanguard-diag-wrap');
  const diagPre   = $('nanguard-diag');

  const gameDir = getGameDir();
  if (!gameDir) {
    if (badge) { badge.textContent = nanGuardStatusLabel('no-game'); badge.className = 'fix-item-badge'; }
    if (applyBtn)  applyBtn.disabled  = true;
    if (revertBtn) revertBtn.disabled = true;
    return;
  }

  try {
    const r = await window.electronAPI.nanGuardStatus?.(gameDir);
    if (!r) return;

    if (badge) {
      badge.textContent = nanGuardStatusLabel(r.status);
      badge.className   = nanGuardBadgeClass(r.status);
    }
    if (applyBtn)  applyBtn.disabled  = (r.status !== 'found');
    if (revertBtn) revertBtn.disabled = (r.status !== 'applied');

    if (note) {
      if (r.status === 'applied') {
        note.textContent = t('nanGuard.noteApplied') || 'Patch is currently applied. Game uses 0.0f fallback instead of hanging.';
        note.className = 'compat-note ok';
      } else if (r.status === 'found') {
        note.textContent = t('nanGuard.noteFound') || 'Ready to apply. Backup will be a sidecar JSON (revert anytime).';
        note.className = 'compat-note';
      } else if (r.status === 'no-pattern') {
        note.textContent = t('nanGuard.noteNoPattern') || 'Pattern not found — your DP.exe is a different build (GOG/cracked/non-Steam?). Patch unsupported.';
        note.className = 'compat-note warn';
      } else if (r.status === 'ambiguous') {
        note.textContent = t('nanGuard.noteAmbiguous') || 'Multiple matches — refusing to patch (unexpected binary layout).';
        note.className = 'compat-note error';
      } else if (r.error) {
        note.textContent = r.error;
        note.className = 'compat-note error';
      } else {
        note.textContent = '';
        note.className = 'compat-note';
      }
    }

    if (diagWrap && diagPre && r.ok) {
      const lines = [
        `SHA-256:     ${r.sha256 || '?'}`,
        `Known good:  ${r.knownGood ? 'YES' : 'no (version drift — patch may still work if pattern matched)'}`,
        `Image base:  0x${(r.imageBase ?? 0).toString(16).padStart(8, '0')}`,
        `.text VA:    0x${(r.textVa ?? 0).toString(16)}`,
        `.text raw:   0x${(r.textRawPtr ?? 0).toString(16)}`,
        `Matches:     original=${r.originalMatches ?? 0}  patched=${r.patchedMatches ?? 0}`,
      ];
      if (r.fileOffset != null) lines.push(`Patch offset: 0x${r.fileOffset.toString(16)} (file)`);
      if (r.va != null)         lines.push(`Patch VA:     0x${r.va.toString(16).padStart(8, '0')}`);
      diagPre.textContent = lines.join('\n');
      diagWrap.hidden = false;
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

async function onNanGuardApply() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const ok = await openConfirm({
    title: t('nanGuard.confirmApplyTitle') || 'Apply experimental NaN Hang Guard?',
    body:  t('nanGuard.confirmApplyBody')  ||
           'Modifies DP.exe on disk: 2 bytes at file offset 0x92A6 (VA 0x00409EA6). ' +
           'A sidecar JSON (.nanguard.json) stores revert metadata. Game will use ' +
           '0.0f fallback instead of hanging when an internal float helper hits NaN. ' +
           'Reversible at any time. EXPERIMENTAL — use only if you experience hangs.',
    okText: t('nanGuard.applyBtn') || 'Apply',
    cancelText: t('skipIntro.confirmCancel') || 'Cancel',
  });
  if (!ok) return;

  const note   = $('nanguard-note');
  const apply  = $('btn-nanguard-apply');
  const revert = $('btn-nanguard-revert');
  if (apply)  apply.disabled  = true;
  if (revert) revert.disabled = true;
  if (note)   { note.textContent = '…'; note.className = 'compat-note'; }

  try {
    const r = await window.electronAPI.nanGuardApply?.(gameDir);
    if (r?.ok) {
      showToast(t('toast.nanGuardApplied') || 'NaN Hang Guard applied ✓', 'success');
      logActivity('completed', `NaN Hang Guard patch applied @ 0x${(r.info?.va || 0).toString(16)}`);
      if (note) {
        note.textContent = r.alreadyApplied
          ? (t('nanGuard.noteAlreadyApplied') || 'Already applied (no change).')
          : (t('nanGuard.noteJustApplied')    || 'Patch applied. Launch the game and test.');
        note.className = 'compat-note ok';
      }
    } else {
      if (note) {
        const msg = r?.error || nanGuardStatusLabel(r?.status);
        note.textContent = msg;
        note.className = 'compat-note error';
      }
      showToast((t('toast.nanGuardErr') || 'Error: ') + (r?.error || r?.status || ''), 'error');
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  } finally {
    refreshNanGuardStatus();
  }
}

async function onNanGuardRevert() {
  const gameDir = getGameDir();
  if (!gameDir) return;
  const ok = await openConfirm({
    title: t('nanGuard.confirmRevertTitle') || 'Revert NaN Hang Guard?',
    body:  t('nanGuard.confirmRevertBody')  || 'Restores the original 2 bytes (EB FE) at the patch site and removes the sidecar JSON.',
    okText: t('nanGuard.revertBtn') || 'Revert',
    cancelText: t('skipIntro.confirmCancel') || 'Cancel',
  });
  if (!ok) return;

  const note   = $('nanguard-note');
  const apply  = $('btn-nanguard-apply');
  const revert = $('btn-nanguard-revert');
  if (apply)  apply.disabled  = true;
  if (revert) revert.disabled = true;
  if (note)   { note.textContent = '…'; note.className = 'compat-note'; }

  try {
    const r = await window.electronAPI.nanGuardRevert?.(gameDir);
    if (r?.ok) {
      showToast(t('toast.nanGuardReverted') || 'NaN Hang Guard reverted ✓', 'success');
      logActivity('info', 'NaN Hang Guard reverted');
      if (note) {
        note.textContent = r.alreadyReverted
          ? (t('nanGuard.noteAlreadyReverted') || 'Already reverted (no change).')
          : (t('nanGuard.noteJustReverted')    || 'Patch reverted. DP.exe is back to its original bytes.');
        note.className = 'compat-note ok';
      }
    } else {
      if (note) {
        note.textContent = r?.error || nanGuardStatusLabel(r?.status);
        note.className   = 'compat-note error';
      }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  } finally {
    refreshNanGuardStatus();
  }
}

// ─── v1.5.0: GPU Driver Compatibility ─────────────────────────────────────────
async function refreshGpuInfo() {
  const list   = $('gpu-list');
  const note   = $('gpu-compat-note');
  const badge  = $('gpu-compat-badge');
  if (!list) return;
  try {
    const r = await window.electronAPI.gpuInfo?.();
    list.innerHTML = '';
    if (!r?.ok || !r.gpus?.length) {
      list.innerHTML = `<div class="info-grid-row"><span class="info-grid-key">${t('gpuCompat.unknown') || 'GPU info unavailable'}</span></div>`;
      if (badge) { badge.textContent = '?'; badge.className = 'fix-item-badge'; }
      return;
    }
    for (const g of r.gpus) {
      const isLegacy = r.legacy?.some(l => l.Name === g.Name);
      const row = document.createElement('div');
      row.className = 'info-grid-row';
      row.innerHTML = `
        <span class="info-grid-key">${g.Name || '?'}</span>
        <span class="info-grid-val">${g.AdapterCompatibility || ''}${g.DriverVersion ? ` · v${g.DriverVersion}` : ''}${isLegacy ? ' · <strong style="color:#e0a02e">legacy</strong>' : ''}</span>
      `;
      list.appendChild(row);
    }
    if (badge) {
      if (r.legacy?.length) {
        badge.textContent = t('gpuCompat.legacyDetected') || '⚠ Legacy GPU';
        badge.className = 'fix-item-badge warn';
      } else {
        badge.textContent = t('gpuCompat.ok') || '✓ Modern GPU';
        badge.className = 'fix-item-badge ok';
      }
    }
    if (note) {
      if (r.legacy?.length) {
        note.textContent = t('gpuCompat.recommendDxvk') ||
          'Older AMD/Intel GPU detected. If you get random in-game hangs, switching to DXVK (Vulkan) is the most reliable fix — it bypasses the legacy D3D9 driver path entirely.';
        note.className = 'compat-note warn';
      } else {
        note.textContent = '';
        note.className = 'compat-note';
      }
    }
  } catch (err) {
    if (note) { note.textContent = err.message; note.className = 'compat-note error'; }
  }
}

// Register event listeners (called from main init flow)
function setupStabilityHandlers() {
  $('btn-stability-apply')?.addEventListener('click', onStabilityApply);
  $('btn-stability-revert')?.addEventListener('click', onStabilityRevert);
  $('btn-crashdump-enable')?.addEventListener('click', onCrashdumpEnable);
  $('btn-crashdump-disable')?.addEventListener('click', onCrashdumpDisable);
  $('btn-crashdump-open')?.addEventListener('click', onCrashdumpOpen);
  $('btn-crashdump-copy')?.addEventListener('click', onCrashdumpCopy);
  $('btn-media-scan')?.addEventListener('click', onMediaScan);
  $('btn-media-test')?.addEventListener('click', onMediaTest);
  $('btn-physx-scan')?.addEventListener('click', refreshPhysxStatus);
  $('btn-physx-download')?.addEventListener('click', onPhysxDownload);
  $('btn-xidi-check')?.addEventListener('click', onXidiCheck);
  $('btn-xidi-open')?.addEventListener('click', onXidiOpen);
  $('btn-diag-export')?.addEventListener('click', onDiagExport);
  $('btn-settings-apply-preset')?.addEventListener('click', onSettingsApplyPreset);
  $('btn-settings-detect-preset')?.addEventListener('click', detectCurrentPreset);
  // v1.5.0
  $('btn-nanguard-scan')?.addEventListener('click', refreshNanGuardStatus);
  $('btn-nanguard-apply')?.addEventListener('click', onNanGuardApply);
  $('btn-nanguard-revert')?.addEventListener('click', onNanGuardRevert);
  $('btn-gpu-rescan')?.addEventListener('click', refreshGpuInfo);
  $('btn-gpu-goto-presets')?.addEventListener('click', () => activateSettingsSection('presets'));
}

// Auto-register if document ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupStabilityHandlers);
} else {
  setupStabilityHandlers();
}

// v1.5.4: re-run every imperative text setter when language changes. Handlers
// that write text via `el.textContent = t(...)` do not get refreshed by
// applyLang() — only [data-i18n] attribute-driven elements do. We listen for
// the custom event emitted by i18n.applyLang and invoke each refresh fn that
// is safe to call repeatedly (idempotent + cheap).
document.addEventListener('dp1-language-changed', () => {
  try { refreshFpsCapStatus?.(); }       catch {}
  try { refreshGpuInfo?.(); }            catch {}
  try { refreshNanGuardStatus?.(); }     catch {}
  try { refreshStabilityMode?.(); }      catch {}
  try { refreshCrashdumpStatus?.(); }    catch {}
  try { refreshPhysxStatus?.(); }        catch {}
  try { refreshDxvkRevertStatus?.(); }   catch {}
  try { refreshDxvkCacheStatus?.(); }    catch {}
  try { refreshCodecFixStatus?.(); }     catch {}
  try { refreshCursorHideStatus?.(); }   catch {}
  try { refreshCaptureCursorStatus?.(); }catch {}
  try { refreshSkipIntroStatus?.(); }    catch {}
  try { refreshCompatStatus?.(); }       catch {}
  try { refreshDxvkToggleStatus?.(); }   catch {}
  try { detectCurrentPreset?.(); }       catch {}
});

