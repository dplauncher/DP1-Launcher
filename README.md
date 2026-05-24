<div align="center">

<img src="assets/DP_LOGO.png" width="120" alt="DP1 Launcher"/>

# DP1 Launcher

**Modern fan-made launcher for _Deadly Premonition: The Director's Cut_**
<br>
_Сучасний фанатський лаунчер для_ **Deadly Premonition: The Director's Cut**

[![GitHub release](https://img.shields.io/github/v/release/dplauncher/DP1-Launcher?style=for-the-badge&color=c4192b)](https://github.com/dplauncher/DP1-Launcher/releases)
[![License](https://img.shields.io/badge/license-MIT-c4192b?style=for-the-badge)](LICENSE)
[![Made by Little Bit](https://img.shields.io/badge/by-%C2%ABLittle%20Bit%C2%BB-c4192b?style=for-the-badge)](https://t.me/LittleBitUA)

</div>

---

## 🇬🇧 In English

One LAUNCH click instead of an hour-long ritual with DPfix, 4GB Patch and DXVK.
The launcher downloads, installs and configures everything for you.

### Features

- 🎮 **Steam launch** in one click (`steam://run/247660`)
- 🔧 **Auto-setup** — DPFix v0.9.5, 4GB LAA Patch, DXVK 2.7.1 are installed on first run
- 🔍 **Steam library autodetect** (registry + `libraryfolders.vdf` parsing)
- 🎨 **Liquid-glass UI** — dark cinematic interface, red accents, Greenvale vibe
- ⚙️ **DPfix.ini editor** — AA, shadows, SSAO, DoF, resolution, display mode, refresh rate
- 💾 **Save backups every 2 minutes** + one-click restore with confirm dialog & character detection
- 🪟 **Windows compatibility** — XP SP3 or Windows 98 / Me via registry
- 📰 **GitHub news feed** — fetched from `news.json` in this repo
- 🔔 **Update notifications** via GitHub Releases API
- 🇺🇦🇬🇧 **Two languages** — Ukrainian and English

### DPC-specific fixes (RE-based)

A dedicated **DPC Fixes** panel aggregates patches that target the
game's known issues:

- 🎯 **FPS Cap 60** — auto-detects your GPU (NVIDIA / AMD / Intel) and
  opens the right driver panel with step-by-step instructions. Locks
  the framerate to 60 to eliminate the engine's `ceil()`-based delta
  time bug that causes "smoking workaround" crashes. _See
  [docs/FPS_TIMING_BUG.md](docs/FPS_TIMING_BUG.md) for the full
  reverse-engineering write-up._
- 🎞 **Cutscene Codec Fix** — session-scoped LAV Filters DirectShow
  merit lowering so Windows-native WMV decoders win the filter graph
  race during cutscenes. Auto-reverts when DP.exe exits, so other
  apps keep their preferred codecs.
- 🖱 **Hide Cursor In-Game** — background PowerShell watcher with
  `AttachThreadInput`-based ShowCursor manipulation. Persistent across
  launcher restarts.
- 🖱 **DPfix CaptureCursor** — alternative cursor fix at the D3D9
  wrapper level via DPfix.ini toggle.
- ⏭ **Skip Intro Videos** — one-byte hex patch on DP.exe (0x243333).
- 🧠 **DXVK Shader Cache** panel — info on game-local cache + NVIDIA
  DXCache / AMD DxCache + per-game cleanup.

### Components used

| Component        | Author                           | Purpose                                       |
|------------------|----------------------------------|-----------------------------------------------|
| **DPFix v0.9.5** | Peter "Durante" Thoman           | Graphical fixer for the game                  |
| **4GB Patch**    | NTCore (Daniel Pistelli)         | Removes the 2 GB RAM ceiling                  |
| **DXVK 2.7.1**   | Philip "doitsujin" Rebohle       | Vulkan renderer for D3D9                      |

### Installation

1. Download the latest version from [Releases](https://github.com/dplauncher/DP1-Launcher/releases)
2. Extract the archive anywhere
3. Run `DP1 Launcher.exe`
4. The launcher autodetects the game in your Steam libraries and offers to install the patches

> **Requirements:** Windows 10 (1803+) or Windows 11, the game installed via Steam.

### Development

```bash
npm install
npm start              # dev mode
npm run pack           # portable build (electron-packager)
```

Stack: **Electron** (vanilla JS, no React/frameworks), worker-threads for INI I/O,
Windows-built-in `tar.exe` for `.tar.gz` extraction, PowerShell for registry ops.

---

## 🇺🇦 Українською

Одне натискання LAUNCH замість години ритуалу з DPfix, патчем 4GB та DXVK.
Лаунчер сам завантажує, встановлює й налаштовує все необхідне.

### Можливості

- 🎮 **Запуск гри через Steam** одним кліком (`steam://run/247660`)
- 🔧 **Автоматична настройка** — DPFix v0.9.5, 4GB LAA Patch, DXVK 2.7.1 ставляться під час першого запуску
- 🔍 **Авто-пошук гри у Steam-бібліотеках** (registry + парсинг `libraryfolders.vdf`)
- 🎨 **Liquid-glass UI** — темний кінематографічний інтерфейс із червоними акцентами, атмосфера Greenvale
- ⚙️ **Редагування DPfix.ini** — AA, тіні, SSAO, DoF, роздільна здатність, режим екрана, частота
- 💾 **Автоматичні бекапи збережень** кожні 2 хвилини + швидке відновлення з визначенням персонажа
- 🪟 **Режим сумісності Windows** — XP SP3 або Windows 98 / Me через реєстр
- 📰 **GitHub-стрічка новин** — лаунчер тягне `news.json` із цього репо
- 🔔 **Перевірка оновлень** через GitHub Releases API
- 🇺🇦🇬🇧 **Дві мови** — українська та англійська

### Спеціалізовані фікси для DPC (на основі reverse engineering)

Окрема панель **DPC Fixes** збирає патчі що цілять у відомі проблеми
гри:

- 🎯 **FPS Cap 60** — автодетектить твою GPU (NVIDIA / AMD / Intel)
  і відкриває правильну панель драйвера з покроковою інструкцією.
  Обмежує FPS до 60, щоб усунути баг `ceil()`-формули delta-time,
  через який зазвичай доводилось курити в грі щоб обійти краш. _Повний
  технічний розбір — [docs/FPS_TIMING_BUG.md](docs/FPS_TIMING_BUG.md)._
- 🎞 **Cutscene Codec Fix** — на час сесії знижує merit DirectShow
  для LAV Filters, щоб Windows-нативні WMV-декодери виграли filter
  graph race у катсценах. Авто-відкат при виході з гри — інші
  програми отримають свої кодеки назад.
- 🖱 **Ховати курсор у грі** — фоновий PowerShell watcher з
  `AttachThreadInput`+ShowCursor. Стан зберігається між запусками
  лаунчера.
- 🖱 **DPfix CaptureCursor** — альтернативний фікс курсору на рівні
  D3D9-wrapper'а через тоггл у DPfix.ini.
- ⏭ **Skip Intro Videos** — одно-байтовий хекс-патч у DP.exe (0x243333).
- 🧠 **Панель DXVK Shader Cache** — інформація про кеш гри + NVIDIA
  DXCache / AMD DxCache + очищення для DP.

### Що використовується

| Компонент       | Автор                            | Призначення                                   |
|-----------------|----------------------------------|-----------------------------------------------|
| **DPFix v0.9.5**| Peter «Durante» Thoman           | Графічний фіксер для гри                       |
| **4GB Patch**   | NTCore (Daniel Pistelli)         | Зняття обмеження 2 ГБ ОЗП                      |
| **DXVK 2.7.1**  | Philip «doitsujin» Rebohle       | Vulkan-рендерер для D3D9                       |

### Встановлення

1. Завантажте останню версію з [Releases](https://github.com/dplauncher/DP1-Launcher/releases)
2. Розпакуйте архів у будь-яку папку
3. Запустіть `DP1 Launcher.exe`
4. Лаунчер сам знайде гру у Steam і запропонує встановити компоненти

> **Вимоги:** Windows 10 (1803+) або Windows 11, інстальована гра в Steam.

### Розробка

```bash
npm install
npm start              # запуск у dev-режимі
npm run pack           # портативний білд (electron-packager)
```

Стек: **Electron** (vanilla JS, без React/фреймворків), worker-threads для INI-I/O,
вбудований Windows `tar.exe` для розпакування `.tar.gz`, PowerShell для роботи з реєстром.

---

## ⚖️ Disclaimer

Цей проєкт не афілійований із Access Games / Rising Star Games / Toybox Inc.
Усі права на гру належать правовласникам. Це — фанатська ініціатива, безкоштовно
і з відкритою душею.

This project is not affiliated with Access Games / Rising Star Games / Toybox Inc.
All rights to the game belong to their respective owners. This is a fan-made,
free, open initiative.

---

<div align="center">

Створено **Dmytro Bidlov** з любов'ю від [«Little Bit»](https://t.me/LittleBitUA) 🇺🇦
&nbsp;·&nbsp;
Made by **Dmytro Bidlov** with love from [«Little Bit»](https://t.me/LittleBitUA) 🇺🇦

Спасибі Swery (Hidetaka Suehiro) за безсмертну, абсурдну й щемливу гру. ✦

</div>
