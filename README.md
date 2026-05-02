# voice-hub

Self-hosted голосовая комната для маленьких компаний. Заточена под игры: фокус на чистом звуке и низкой задержке.

- одна постоянная комната, 3–10 человек
- WebRTC через embedded pion SFU (audio-only, в одном Go-процессе)
- два движка денойза на выбор, переключение без переподключения
- весь стейт в браузере — никаких аккаунтов

## Local dev

```bash
docker compose up -d --build
```

Открыть `http://localhost:8080`. Логин/пароль: `dev` / `dev` (basic auth, переопредели через `APP_AUTH_USER` / `APP_AUTH_PASSWORD` в `docker-compose.yml`). Стоп: `docker compose down`. Логи: `docker compose logs -f app janus`.

## Production

VPS + GitHub Actions + Caddy auto-TLS. Push в master → CI собирает образы в `ghcr.io` и деплоит на сервер. Детали в [DEPLOY.md](DEPLOY.md).

## Desktop (Tauri)

Desktop-обёртка на Tauri 2 в `src-tauri/`. Грузит remote URL (`APP_BASE_URL`, по умолчанию `http://localhost:8080/`) через `WebviewUrl::External` — webview сам сохраняет cookie между запусками, login один раз. В бинаре только hostname, никаких секретов.

### Скачать готовый билд (Windows)

Билды собираются GitHub Actions, публикуются в [Releases](https://github.com/klimovI/voice-hub/releases/latest):

- **`Voice Hub_<version>_x64-setup.exe`** — NSIS-установщик: ярлыки в "Пуске", запись в "Programs and Features", автоустановка WebView2 если отсутствует. Поддерживает auto-update через `tauri-plugin-updater` (детали в [UPDATER.md](UPDATER.md)).

### Релиз (как собрать новый билд)

Авто-релиз: push изменений в `src-tauri/**` в master → `auto-tag-desktop.yml` бампит patch версию → тег `v*` → `release-desktop.yml` собирает + подписывает + публикует. Изменения в `frontend/**` или `backend/**` шелл-релиз не требуют — фронт обновляется через backend deploy сам по себе.

Ручной запуск (если надо протестить): Actions → "Release Desktop" → "Run workflow".

Версия в имени `.exe` берётся из `src-tauri/tauri.conf.json` → `version`. Перед тегом обнови это поле, иначе несколько релизов будут собираться с одинаковым именем файла.

### Локальная сборка

**Требования:** Rust toolchain, `cargo install tauri-cli --version '^2'`, системные зависимости Tauri.

**Запуск из исходников:**

```bash
cd src-tauri
cargo tauri dev
```

**Кросс-сборка под Windows из Linux** через `cargo-xwin` — детали в [TAURI_WINDOWS_BUILD_PLAN.md](TAURI_WINDOWS_BUILD_PLAN.md). Артефакт — NSIS-установщик.

### Конфигурация

Build-time env: `APP_BASE_URL` (например `https://your-host.example.com/`). Бейкается в бинарь через `option_env!`. Дефолт — `http://localhost:8080/`. Никаких секретов в бинаре: ICE-конфиг и signaling клиент тянет из бэкенда после login.

Hotkey в Tauri пока оконный, не глобальный системный.

## Структура

```
backend/   Go HTTP-сервер: auth + статика + /ws (signaling) + pion SFU + pion TURN
frontend/  React 18 + TypeScript + Vite. Билдится в web/.
web/       build output из frontend/ (статика, отдаётся бэкендом)
src-tauri/ desktop-обёртка на Tauri 2 (remote URL)
deploy/    Caddyfile
.github/   CI: build & push в ghcr.io, deploy по SSH
```

Дальше: [DEPLOY.md](DEPLOY.md) — прод на VPS · [ROADMAP.md](ROADMAP.md) — что сделано и что дальше.

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

Один Go-бинарь делает всё: cookie-auth, отдача статики из `web/`, JSON-WS signaling, pion SFU (audio-only forwarding), pion TURN (HMAC short-term creds). Janus и coturn убраны.

Свой speaking считается локально по RMS на `AnalyserNode`. Чужой speaking-индикатор не реализован (server-side VAD пока нет в pion SFU-обёртке).

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
