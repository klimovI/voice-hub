# Roadmap

Внутренний трекер: что сделано, что в работе, что отложено.

## Done

### Audio
- [x] Janus VideoRoom (audio-only) + WebSocket signaling
- [x] Локальный mute и громкость по каждому участнику
- [x] RNNoise как первый движок денойза
- [x] DTLN как второй движок (лучше на транзиентах — клики мыши/клавы)
- [x] Hot-swap движков без переподключения к Janus
- [x] VAD-gated envelope на RNNoise — давит клики/клаву в тишине, не режет хвосты слов
- [x] Per-participant volume через Web Audio Gain (>100% реально работает)
- [x] Soft compressor + HPF/LPF в mic-цепочке (мягкий, без пампинга)
- [x] Speaking-индикатор — server-side для других, локальный AnalyserNode для себя
- [x] Все клиентские настройки в localStorage

### UX
- [x] Тёмная тема с читаемым контрастом
- [x] Deafen mode (mute mic + output одной кнопкой)
- [x] Расширенные диапазоны слайдеров громкости
- [x] Hotkey toggle-mute (по умолчанию Ctrl+Shift+M)

### Infra
- [x] `docker-compose.yml` для локального dev
- [x] Backend с health-check и room-конфигом
- [x] Production deploy на VPS — Caddy auto-TLS, GitHub Actions build & push в ghcr.io, SSH deploy под non-root user. Подробнее в [DEPLOY.md](DEPLOY.md)
- [x] Tauri 2 desktop-обёртка для Windows, кросс-сборка из Linux через cargo-xwin, NSIS installer

## In progress

_(пусто)_

## Next

### Audio
- [ ] Wet/dry для DTLN с компенсацией latency через DelayNode
- [ ] Опциональный gate на DTLN-выходе если клики прорываются в реальной игре
- [ ] DeepFilterNet3 как третий движок если DTLN недостаточен
- [ ] Migration на AudioWorklet (ScriptProcessorNode deprecated)

### UX
- [ ] **Глобальный hotkey** через browser extension — web-страница не может зарегистрировать system-wide шорткат
- [ ] Push-to-talk режим

### Infra
- [ ] Persistent room state на бекенде
- [ ] Опциональный basic-auth перед Caddy

## Frozen / decided not to do

- ❌ **Каскад DTLN+RNNoise.** Двойное нейронное подавление даёт musical-noise артефакты. Один движок за раз.
- ❌ **Аккаунты / много комнат.** Не нужно для 3 человек.
