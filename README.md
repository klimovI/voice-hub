# voice-hub

Self-hosted голосовая комната для маленьких компаний. Заточена под игры: фокус на чистом звуке и низкой задержке.

- одна постоянная комната, 3–10 человек
- WebRTC через Janus VideoRoom (audio-only SFU)
- два движка денойза на выбор, переключение без переподключения
- весь стейт в браузере — никаких аккаунтов

## Local dev

```bash
docker compose up -d --build
```

Открыть `http://localhost:8080`. Стоп: `docker compose down`. Логи: `docker compose logs -f app janus`.

## Production

VPS + GitHub Actions + Caddy auto-TLS. Push в master → CI собирает образы в `ghcr.io` и деплоит на сервер. Детали в [DEPLOY.md](DEPLOY.md).

## Desktop (Tauri)

Desktop-обёртка на Tauri 2 в `src-tauri/`. Использует `web/` как frontend, конфиг получает через Rust-команду `get_app_config` (читает env), а не через `/api/config` Go-бэкенда.

**Требования:** Rust toolchain, `cargo install tauri-cli --version '^2'`, системные зависимости Tauri.

**Запуск из исходников:**

```bash
cd src-tauri
cargo tauri dev
```

**Кросс-сборка под Windows из Linux** через `cargo-xwin` — детали в [TAURI_WINDOWS_BUILD_PLAN.md](TAURI_WINDOWS_BUILD_PLAN.md). Артефакт — NSIS-установщик.

Env переменные — `JANUS_WS_URL`, `ROOM_ID`, `ROOM_PIN`, `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD`. Дефолты в `src-tauri/src/lib.rs` указывают на `localhost` — для прод-сборки либо заменить дефолты, либо передать env в момент запуска.

Hotkey в Tauri пока оконный, не глобальный системный.

## Структура

```
backend/   Go HTTP-сервер: статика + /api/config
web/       vanilla JS клиент (WebRTC, аудиограф, UI)
src-tauri/ desktop-обёртка на Tauri 2
deploy/    Caddyfile + конфиги Janus
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
     │  ┌────────────────────┐ ┌──────┐
     ├──┤      janus         │ │ app  │
     │  │  VideoRoom (audio) │ └──────┘
     │  └────────────────────┘
     │  ┌────────────────────┐
     └──┤      coturn        │  STUN/TURN fallback
        └────────────────────┘
```

Backend — статик-сервер плюс один JSON-эндпоинт с конфигом комнаты. Вся логика signaling-а в браузере: клиент сам открывает WebSocket к Janus, делает publish и подписывается на остальных участников. Если комнаты нет — клиент создаёт её сам.

Speaking-индикатор у других участников приходит как Janus event `talking`/`stopped-talking`. Свой считается локально по RMS на `AnalyserNode`.

### Аудиограф

Главный `AudioContext` 48 kHz:

```
mic ──▶ [denoiser] ──▶ HPF ──▶ LPF ──▶ compressor ──▶ gain ──▶ WebRTC
```

`getUserMedia` оставляет echo-cancellation, но **отключает** браузерный noise-suppression и AGC — иначе двойная обработка с нашим денойзером режет речь.

Удалённый звук разворачивается через `MediaStreamSource → GainNode → destination` — это позволяет крутить громкость отдельных участников выше 100% (`HTMLMediaElement.volume` клампится 0..1, а нам нужно громче для тихих микрофонов).

### Денойзеры

| Engine | Сильные стороны | Слабые стороны |
|---|---|---|
| **RNNoise** | дёшево по CPU, хорошо на стационарном шуме (фен, кулер) | плохо ловит транзиенты — клики мыши/клавы |
| **DTLN** | заметно лучше на транзиентах, нейронка нового поколения | тяжелее, инициализация ~9 МБ, чуть выше латентность |

Переключение горячее, через `RTCRtpSender.replaceTrack` — peer'ы не переподключаются.

RNNoise дополнительно использует свой VAD: во время тишины подавление сильнее, при речи — слабее. Гистерезис и hold не дают резать хвосты слов. Слайдер "Suppression strength" контролирует силу подавления RNNoise; для DTLN это пока on/off.

**Каскад двух нейронок не делается** — DTLN ждёт сырой шум на входе, после RNNoise начинает резать речь как шум. Один движок за раз.

### Persistence

Всё локальное состояние — в `localStorage`: имя, выбранный движок, силы и громкости, mute toggles, hotkey. Никаких аккаунтов на бекенде.
