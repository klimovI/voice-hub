# Issues & Features

Список проблем и фич. Делаем по порядку сверху вниз.

## Open

1. **Обрываются слова** — речь рвётся, теряются окончания/начала слов. Случается редко.
2. **Индикатор говорящего** — UI-индикатор, кто из участников сейчас говорит.
3. **Долгий `Запрашиваю микрофон…`** — статус иногда висит долго на старте join. Возможные причины: медленная инициализация WASM (DTLN/RNNoise preload), задержка `navigator.mediaDevices.getUserMedia` от ОС, прогрев `AudioContext.resume()`. Нужно профилировать `prepareLocalAudio` (`frontend/src/hooks/useAudioEngine.ts`).

## In Progress

- **Потрещивания микрофона** — фаза 2 закрыта (remote limiter). Замечено: щелчки приходят **только при включённом RNNoise-движке** (DTLN/off — чисто). Это указывает на ScriptProcessor RNNoise как источник, даже после zero-alloc-фикса (главный поток всё равно может стопориться на React-рендерах/zustand-обновлениях). После деплоя фазы 2 нужно перетестировать; если потрескивания всё ещё ловятся в RNNoise-режиме — переходим к:
  - debounce SFU renegotiation в `backend/internal/sfu/sfu.go:358-369` (щелчки на join/leave — независимо от движка)
  - полный AudioWorklet port RNNoise (требует патча vendor `frontend/public/vendor/rnnoise/rnnoise.js` — emscripten env-check)

## Done

- **Вылет через ~10 мин** (`backend/internal/turn/turn.go`): причина — pion/turn дефолтит `AllocationLifetime`/`ChannelBindTimeout`/`PermissionTimeout` в 10 минут. Бамп на 8 часов.
- **Потрескивания — фаза 2** (`frontend/src/audio/remote.ts`): на remote-стороне стоял brick-wall лимитер DynamicsCompressor (`threshold=-1, knee=0, ratio=20, attack=1ms, release=50ms`). Web Audio compressor с 1мс атакой и hard knee даёт IM-искажения на транзиентах речи. Смягчили до `-6/6/8/5ms/100ms`.
- **Авто-переподключение фронта** (`frontend/src/App.tsx`): при `failed`/`closed` PC/WS — backoff-реконнект (1, 2, 4, 8, 15, 30, 30 s, 7 попыток); сохраняем mic graph (без повторного getUserMedia); чистим remote-аудио и participants перед каждой попыткой; ручной leave прерывает реконнект.
- **Потрескивания — фаза 1** (commit `0e632af`):
  - `getUserMedia` → `sampleRate: 48000` (`frontend/src/hooks/useAudioEngine.ts`) — убран OS-resample на входе.
  - Remote `AudioContext` → `{ sampleRate: 48000 }` (`frontend/src/audio/remote.ts`) — убран ресемпл на выходе.
  - RNNoise ScriptProcessor: zero-allocation hot path (`frontend/src/audio/rnnoise.ts`). Pre-allocated `inputRing`/`outputRing` (4096 sample) + `scratchFrame`/`scratchOriginal`. Убран GC main thread → underrun → щелчки.
