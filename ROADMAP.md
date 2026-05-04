# Roadmap

Внутренний трекер: что сделано, что в работе, что отложено.

## Done

### Audio
- [x] Embedded pion SFU (audio-only) + JSON-WS signaling в одном Go-процессе
- [x] Локальный mute и громкость по каждому участнику
- [x] RNNoise как первый движок денойза
- [x] DTLN как второй движок (лучше на транзиентах — клики мыши/клавы)
- [x] Hot-swap движков без переподключения (RTCRtpSender.replaceTrack)
- [x] VAD-gated envelope на RNNoise — давит клики/клаву в тишине, не режет хвосты слов
- [x] Per-participant volume через Web Audio Gain (>100% реально работает)
- [x] Soft compressor + HPF/LPF в mic-цепочке (мягкий, без пампинга)
- [x] Speaking-индикатор для себя — локальный AnalyserNode (RMS)
- [x] Все клиентские настройки в localStorage

### UX
- [x] Тёмная тема с читаемым контрастом
- [x] Deafen mode (mute mic + output одной кнопкой)
- [x] Расширенные диапазоны слайдеров громкости
- [x] Hotkey toggle-mute (по умолчанию Ctrl+Shift+M)
- [x] Глобальный hotkey в Tauri через `rdev` (срабатывает когда окно не в фокусе)
- [x] Minimize-to-tray (Discord-style) — окно сворачивается в трей вместо закрытия

### Infra
- [x] `docker-compose.dev.yml` для локального dev (loopback bind, требует `APP_ALLOW_INSECURE=1`)
- [x] Backend с health-check и room-конфигом
- [x] Production deploy на VPS — Caddy auto-TLS, GitHub Actions build & push в ghcr.io, SSH deploy под non-root user. Подробнее в [DEPLOY.md](DEPLOY.md)
- [x] Tauri 2 desktop-обёртка для Windows (remote URL, без секретов в бинаре), кросс-сборка из Linux через cargo-xwin, NSIS installer
- [x] Cookie-session auth (HttpOnly signed) + login form на `/login.html`; `/healthz` публичный, `/api/login` rate-limited
- [x] Embedded pion/turn (HMAC short-term creds через `/api/ice-config`) — coturn убран
- [x] Прод `.env` провижится из GitHub secret `PROD_ENV` на каждом деплое (single source of truth)
- [x] Frontend переписан на React 18 + TypeScript + Vite (multi-page index/login, zustand)

## In progress

_(пусто)_

## Next

### Audio
- [ ] Wet/dry для DTLN с компенсацией latency через DelayNode
- [ ] Опциональный gate на DTLN-выходе если клики прорываются в реальной игре
- [ ] DeepFilterNet3 как третий движок если DTLN недостаточен
- [ ] Migration на AudioWorklet (ScriptProcessorNode deprecated)

### UX
- [ ] Push-to-talk режим
- [ ] Speaking-индикатор для чужих (server-side VAD в pion SFU)

### Infra
- [ ] Persistent room state на бекенде

## Frozen / decided not to do

- ❌ **Аккаунты / много комнат.** Не нужно для 3 человек.
