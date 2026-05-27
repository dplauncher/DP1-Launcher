'use strict';
/**
 * i18n.js — UI translations (Ukrainian / English)
 *
 * Translations live in /loc/ukr.json and /loc/eng.json — edit those files
 * to add or correct strings. This module loads them via IPC at startup
 * (window.electronAPI.getTranslations) and exposes the same helpers used
 * throughout the renderer:
 *
 *   await initI18n()  → must be awaited before any t() call
 *   t('key')          → translated string for current language
 *   applyLang('uk')   → apply language to all [data-i18n*] elements
 *   getCurrentLang()  → 'uk' | 'en'
 */

let TRANSLATIONS = { uk: {}, en: {} };
let currentLang  = 'uk';

/**
 * Load all translation JSON files. Must be awaited before any t() call.
 * Falls back to an empty dictionary on failure so the app still boots
 * (keys are then shown verbatim — useful as a missing-translation signal).
 */
async function initI18n() {
  try {
    const data = await window.electronAPI.getTranslations();
    if (data && typeof data === 'object') {
      TRANSLATIONS = {
        uk: data.uk || {},
        en: data.en || {},
      };
    }
  } catch (err) {
    console.error('[i18n] Failed to load translations:', err);
  }
}

/** Return translated string for current language, fall back to Ukrainian, then the key itself */
function t(key) {
  return TRANSLATIONS[currentLang]?.[key]
      ?? TRANSLATIONS.uk?.[key]
      ?? key;
}

function getCurrentLang() { return currentLang; }

/**
 * Apply a language to all marked DOM elements.
 * Elements must be in the DOM when called.
 *   data-i18n="key"             → el.textContent
 *   data-i18n-html="key"        → el.innerHTML  (supports <strong>, <code>, etc.)
 *   data-i18n-placeholder="key" → el.placeholder
 *   data-i18n-title="key"       → el.title
 */
function applyLang(lang) {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });

  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });

  document.documentElement.lang = lang === 'uk' ? 'uk' : 'en';

  // Update toggle button label to show the OTHER language (the one you'd switch to)
  const btn = document.getElementById('btn-lang');
  if (btn) btn.textContent = lang === 'uk' ? 'EN' : 'UA';

  // Notify any imperative text setters (refreshFpsCapStatus, refreshGpuInfo,
  // refreshNanGuardStatus, …) that they need to re-localize. The static
  // data-i18n attributes above are already done; this event covers buttons /
  // status pills whose text is written by JS at runtime with t() + substitution.
  document.dispatchEvent(new CustomEvent('dp1-language-changed', { detail: { lang } }));
}
