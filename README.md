<p align="center">
  <img src="docs/logo.svg" alt="voice-hub" width="128" height="128">
</p>

# voice-hub

[![Latest release](https://img.shields.io/github/v/release/klimovI/voice-hub?label=release&color=blue)](https://github.com/klimovI/voice-hub/releases/latest)
[![Release Desktop](https://github.com/klimovI/voice-hub/actions/workflows/release-desktop.yml/badge.svg)](https://github.com/klimovI/voice-hub/actions/workflows/release-desktop.yml)
[![License](https://img.shields.io/github/license/klimovI/voice-hub)](LICENSE)

Self-hosted голосовая комната для маленьких компаний. Заточена под игры: фокус на чистом звуке и низкой задержке.

- одна постоянная комната, 3–10 человек
- WebRTC через embedded pion SFU (audio-only, в одном Go-процессе)
- два движка денойза на выбор, переключение без переподключения
- весь стейт в браузере — никаких аккаунтов

## Скачать (Windows)

⬇ **[Последний релиз](https://github.com/klimovI/voice-hub/releases/latest)** → `Voice.Hub_<version>_x64-setup.exe`.

NSIS-установщик: ярлыки в "Пуске", запись в "Programs and Features", автоустановка WebView2 если отсутствует. Auto-update встроен.

> При первом запуске Windows SmartScreen может показать предупреждение (бинарь без Authenticode-сертификата). Нажмите **«Подробнее»** → **«Выполнить в любом случае»**.

## Local dev

Полный стек в Docker:

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Бэк биндится на `127.0.0.1:8080` — наружу хоста не торчит. Открыть `http://localhost:8080`, зайти паролем `dev` (admin; переопредели через `APP_ADMIN_PASSWORD` в `docker-compose.dev.yml`). После входа: шестерёнка-ключ в правом верхнем углу → **Создать пароль** — это и есть «connection password» для остальных пользователей. Стоп: `docker compose -f docker-compose.dev.yml down`. Логи: `docker compose -f docker-compose.dev.yml logs -f app`.

Дев-конфиг требует `APP_ALLOW_INSECURE=1` (cookie без Secure + дефолтный admin-пароль). Без флага бинарь не стартует — ловим случайный запуск дев-енва на публичном хосте.

> **WSL2 + Docker Engine:** биндинг `127.0.0.1:8080` вешается на loopback виртуалки, не Windows. Если из Windows-браузера `localhost:8080` не открывается, создай локальный `docker-compose.override.yml` (gitignored) с `0.0.0.0:8080:8080`.

### Разработка фронта (бэк в докере, фронт локально с HMR)

```bash
docker compose -f docker-compose.dev.yml up -d app   # бэк на :8080
cd frontend && npm install && npm run dev            # vite на :5173
```

Открыть `http://localhost:5173`. Vite проксирует `/api` и `/ws` на бэк (см. `frontend/vite.config.ts`), так что login и WebRTC работают как из обычного :8080.

## Production

VPS + GitHub Actions + Caddy + Cloudflare proxy. Push в master → CI собирает образы в `ghcr.io` и деплоит на сервер.

TURN поднимается одним транспортом: `turn://:3478?transport=udp`. Voice — UDP-only, как у Discord. Сети, где UDP полностью зарезан, не поддерживаются: TCP/TLS-фолбэка нет, и стоковый `caddy:2-alpine` его не предполагает.

## Desktop (Tauri)

Desktop-обёртка на Tauri 2 в `src-tauri/`. Бинарь generic — никаких host'ов или секретов. При первом запуске показывает локальный экран `connect.html` для ввода адреса сервера; host сохраняется в OS keychain. Смена сервера через трей: `Change server` / `Disconnect`.

Глобальный hotkey (toggle-mute, по умолчанию `Ctrl+Shift+M`) работает системно через `rdev` — слышит нажатие даже когда окно не в фокусе.

### Релиз

Авто-релиз: push изменений в `src-tauri/**` в master → `auto-tag-desktop.yml` бампит patch → тег `v*` → `release-desktop.yml` собирает + подписывает + публикует в GitHub Releases. Изменения только в `frontend/**` или `backend/**` шелл-релиз не требуют — фронт обновляется через backend deploy.

Ручной запуск: Actions → "Release Desktop" → "Run workflow".

Подробнее про auto-update — в [UPDATER.md](UPDATER.md).

### Локальная сборка

**Из исходников (dev-режим):**

```bash
cd src-tauri
cargo install tauri-cli --version '^2'   # один раз
cargo tauri dev
```

**Кросс-сборка под Windows из Linux/WSL** через [`cargo-xwin`](https://github.com/rust-cross/cargo-xwin):

```bash
cd src-tauri
cargo install cargo-xwin
rustup target add x86_64-pc-windows-msvc
CARGO_HTTP_TIMEOUT=600 CARGO_NET_RETRY=10 \
  cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
```

Артефакт — NSIS-установщик в `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

### Конфигурация

Никаких build-time env. Бинарь generic, host вводится пользователем при первом запуске и хранится в OS keychain (`keyring` crate). ICE/TURN-конфиг и signaling клиент тянет из бэкенда после login.

## Структура

```
backend/   Go HTTP-сервер: auth + статика + /ws (signaling) + pion SFU + pion TURN
frontend/  React 18 + TypeScript + Vite. Билдится в frontend/dist/
src-tauri/ desktop-обёртка на Tauri 2 (remote URL)
deploy/    Caddyfile
.github/   CI: build & push в ghcr.io, deploy по SSH, release desktop
```

Дальше: [ROADMAP.md](ROADMAP.md) — что сделано и что дальше · [AGENTS.md](AGENTS.md) — правила для AI-агентов.

---

## Архитектура

### Компоненты

```
┌─────────┐    HTTPS/WSS     ┌──────────┐
│ browser │ ───────────────▶ │  caddy   │  (только в проде)
└─────────┘                  └─────┬────┘
     │                             │
     │  WebRTC (UDP)               ▼
     │       ┌──────────────────────────┐
     ├──────▶│           app            │
     │       │  static + auth + /ws     │
     │       │  pion SFU + pion TURN    │
     └──────▶└──────────────────────────┘
```

Один Go-бинарь делает всё: cookie-auth, отдача статики из `frontend/dist/`, JSON-WS signaling, pion SFU (audio-only forwarding), pion TURN (HMAC short-term creds).

Свой speaking считается локально по RMS на `AnalyserNode`. Чужой speaking-индикатор не реализован.

### Аудиограф

Главный `AudioContext` 48 kHz:

```
mic ──▶ [denoiser] ──▶ HPF ──▶ LPF ──▶ compressor ──▶ gain ──▶ WebRTC
```

`getUserMedia` оставляет echo-cancellation, но **отключает** браузерный noise-suppression и AGC — иначе двойная обработка с нашим денойзером режет речь.

Удалённый звук разворачивается через `MediaStreamSource → GainNode → destination` — это позволяет крутить громкость отдельных участников выше 100% (`HTMLMediaElement.volume` клампится 0..1, а нам нужно громче для тихих микрофонов).

### Денойзеры

| Engine      | Сильные стороны                                         | Слабые стороны                                      |
| ----------- | ------------------------------------------------------- | --------------------------------------------------- |
| **RNNoise** | дёшево по CPU, хорошо на стационарном шуме (фен, кулер) | плохо ловит транзиенты — клики мыши/клавы           |
| **DTLN**    | заметно лучше на транзиентах, нейронка нового поколения | тяжелее, инициализация ~9 МБ, чуть выше латентность |

Переключение горячее, через `RTCRtpSender.replaceTrack` — peer'ы не переподключаются.

RNNoise дополнительно использует свой VAD: во время тишины подавление сильнее, при речи — слабее. Гистерезис и hold не дают резать хвосты слов. Слайдер "Suppression strength" контролирует силу подавления RNNoise; для DTLN это пока on/off.

**Каскад двух нейронок не делается** — DTLN ждёт сырой шум на входе, после RNNoise начинает резать речь как шум. Один движок за раз.

### Persistence

Всё локальное состояние — в `localStorage`: имя, выбранный движок, силы и громкости, mute toggles, hotkey. Никаких аккаунтов на бекенде.
