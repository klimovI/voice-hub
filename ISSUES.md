# Issues & Features

Список проблем и фич. Делаем по порядку сверху вниз.

## Open

1. **Вылет через ~10 мин** — соединение/клиент падает примерно через 10 минут после старта.
2. **Обрываются слова** — речь рвётся, теряются окончания/начала слов. Случается редко.
3. **Индикатор говорящего** — UI-индикатор, кто из участников сейчас говорит.

## In Progress

- **Потрещивания микрофона** — частично закрыто (см. Done). Если после деплоя ещё слышны щелчки:
  - debounce SFU renegotiation в `backend/internal/sfu/sfu.go:358-369` (щелчки на join/leave)
  - полный AudioWorklet port RNNoise (требует патча vendor `frontend/public/vendor/rnnoise/rnnoise.js` — emscripten env-check)

## Done

- **Авто-переподключение фронта** (`frontend/src/App.tsx`): при `failed`/`closed` PC/WS — backoff-реконнект (1, 2, 4, 8, 15, 30, 30 s, 7 попыток); сохраняем mic graph (без повторного getUserMedia); чистим remote-аудио и participants перед каждой попыткой; ручной leave прерывает реконнект.
- **Потрескивания микрофона — фаза 1** (commit `0e632af`):
  - `getUserMedia` → `sampleRate: 48000` (`frontend/src/hooks/useAudioEngine.ts`) — убран OS-resample на входе.
  - Remote `AudioContext` → `{ sampleRate: 48000 }` (`frontend/src/audio/remote.ts`) — убран ресемпл на выходе.
  - RNNoise ScriptProcessor: zero-allocation hot path (`frontend/src/audio/rnnoise.ts`). Pre-allocated `inputRing`/`outputRing` (4096 sample) + `scratchFrame`/`scratchOriginal`. Убран GC main thread → underrun → щелчки.
