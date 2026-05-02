# Issues & Features

Список проблем и фич. Делаем по порядку сверху вниз.

## Open

_(empty — see Done for the suspected fix on word cutoffs; needs field verification)_

## In Progress

- **Потрещивания микрофона** — фаза 2 закрыта (remote limiter). Замечено: щелчки приходят **только при включённом RNNoise-движке** (DTLN/off — чисто). Это указывает на ScriptProcessor RNNoise как источник, даже после zero-alloc-фикса (главный поток всё равно может стопориться на React-рендерах/zustand-обновлениях). После деплоя фазы 2 нужно перетестировать; если потрескивания всё ещё ловятся в RNNoise-режиме — переходим к:
  - debounce SFU renegotiation в `backend/internal/sfu/sfu.go:358-369` (щелчки на join/leave — независимо от движка)
  - полный AudioWorklet port RNNoise (требует патча vendor `frontend/public/vendor/rnnoise/rnnoise.js` — emscripten env-check)

## Done

- **Обрываются слова** (`frontend/src/audio/rnnoise.ts`, suspected — needs field test): RNNoise VAD-gate был слишком плотным — `GATE_OPEN_VAD=0.55`, `GATE_HOLD_MS=150ms`, `GATE_MAX_ATTEN_DB=36`. Тихие фонемы на границах слов (свистящие/шипящие, мягкие согласные) не пробивали 0.55 → gate закрывался через ~150ms hold + 180ms release, отдавая ~25dB attenuation на дефолтном миксе 70%. Релакс: `GATE_OPEN_VAD=0.4`, `GATE_HOLD_MS=300`, `GATE_MAX_ATTEN_DB=18`. SFU-сторона чистая (pion forwards RTP as-is, без DTX/buffering), так что виновник — локальный gate. Если в проде слова всё равно теряются — следующий шаг убрать gate целиком (или вынести его в UI-toggle).
- **Индикатор говорящего** (`frontend/src/audio/remote.ts`, `frontend/src/hooks/useAudioEngine.ts`): per-participant `AnalyserNode` + единый rAF-цикл с 250ms hold; обновляет `participants[id].speaking` при пересечении RMS-порога. UI уже подсвечивал `speaking`, нужна была только проводка для remote.
- **Долгий `Запрашиваю микрофон…`** — основная причина: cold-cache fetch `/vendor/rnnoise/rnnoise.js` (4.83MB raw / ~420KB gzip; на одном медленном канале gzip-передача заняла 1326с). Меры:
  - `Cache-Control: public, max-age=31536000, immutable` для `/vendor/*` (`deploy/Caddyfile`) — повторные визиты бесплатны.
  - `<link rel="modulepreload" href="/vendor/rnnoise/rnnoise.js">` (`frontend/index.html`) — fetch стартует параллельно с main bundle.
  - `getUserMedia` теперь идёт параллельно с `new AudioContext` + `resume()` (`useAudioEngine.prepareLocalAudio`).
  - `preloadEngine()` вызывается на mount и в `handleEngineSelect`, не только для RNNoise.
  - Промежуточный статус `Загрузка шумоподавителя…` после готовности микрофона.
  - **Non-blocking Join hot-swap** (`App.tsx`, `useAudioEngine.ts`): если WASM-движок ещё не загружен на момент Join, граф собирается с `engine=off`, юзер сразу попадает в комнату, а в фоне догружается выбранный движок и `rebuildLocalAudio` тихо переключает граф (без разрыва PC/track — `replaceTrack` на сендере). Старый speaking-loop отменяется в teardown, поэтому после rebuild перезапускаем его на новом графе.
- **Вылет через ~10 мин** (`backend/internal/turn/turn.go`): причина — pion/turn дефолтит `AllocationLifetime`/`ChannelBindTimeout`/`PermissionTimeout` в 10 минут. Бамп на 8 часов.
- **Потрескивания — фаза 2** (`frontend/src/audio/remote.ts`): на remote-стороне стоял brick-wall лимитер DynamicsCompressor (`threshold=-1, knee=0, ratio=20, attack=1ms, release=50ms`). Web Audio compressor с 1мс атакой и hard knee даёт IM-искажения на транзиентах речи. Смягчили до `-6/6/8/5ms/100ms`.
- **Авто-переподключение фронта** (`frontend/src/App.tsx`): при `failed`/`closed` PC/WS — backoff-реконнект (1, 2, 4, 8, 15, 30, 30 s, 7 попыток); сохраняем mic graph (без повторного getUserMedia); чистим remote-аудио и participants перед каждой попыткой; ручной leave прерывает реконнект.
- **Потрескивания — фаза 1** (commit `0e632af`):
  - `getUserMedia` → `sampleRate: 48000` (`frontend/src/hooks/useAudioEngine.ts`) — убран OS-resample на входе.
  - Remote `AudioContext` → `{ sampleRate: 48000 }` (`frontend/src/audio/remote.ts`) — убран ресемпл на выходе.
  - RNNoise ScriptProcessor: zero-allocation hot path (`frontend/src/audio/rnnoise.ts`). Pre-allocated `inputRing`/`outputRing` (4096 sample) + `scratchFrame`/`scratchOriginal`. Убран GC main thread → underrun → щелчки.
