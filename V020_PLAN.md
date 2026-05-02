# v0.2.0 Plan: Global Mute Hotkey + Discord-like Sounds

> Draft for review. Скоуп — глобальный hotkey toggle mute (любая клавиша/кнопка мыши, в т.ч. когда окно не в фокусе) + два различимых звука на mute/unmute.

## Архитектура

```
┌──────────────────────────┐         events           ┌──────────────────────┐
│  rdev listener thread     │ ─── "toggle-mute" ──▶  │   Frontend (React)    │
│  (Rust, src-tauri)        │ ─── "input-captured" ▶ │   - listen() events   │
│  - reads config from disk │                          │   - HotkeyCard ext'd │
│  - matches input          │ ◀── invoke ────────────  │   - 2 synth sounds   │
│  - capture mode           │   set/get/start_capture  │                       │
└──────────────────────────┘                          └──────────────────────┘
```

## Текущее состояние (на чём строим)

- `selfMuted` в `frontend/src/store/useStore.ts:35` + `setSelfMuted` (line 83)
- Toggle: `App.tsx:102` (`handleToggleSelfMute`)
- Существующий in-window hotkey: `useShortcut.ts` через `window.keydown` (только при фокусе на окне)
- Persistence shortcut'а: `localStorage` под ключом `voice-hub.shortcut` (`utils/shortcut.ts:25`)
- Audio context: `audio/remote.ts:20-29` (`ensureRemoteAudioContext()`) — подходит для playback
- Settings UI: `components/HotkeyCard.tsx` — точка расширения
- Frontend грузится с remote URL (`WebviewUrl::External`) — IPC default-deny
- Tauri detection: отсутствует, нужно добавить

## Шаги (последовательно)

### 1. Rust: input shortcut модель + персистенция

**Новый файл:** `src-tauri/src/shortcut.rs`

```rust
enum InputBinding {
    Keyboard(Vec<Key>),  // sorted, deduped, e.g. [Ctrl, Shift, M]
    Mouse(Button),       // Right, Middle, Side1..N
}
```

- Persist в `app.path().app_config_dir() / "shortcut.json"` (Tauri-managed путь)
- Функции `load() -> Option<InputBinding>` и `save(binding) -> io::Result<()>`
- Сериализация через `serde_json`

### 2. Rust: rdev listener thread

**Новый файл:** `src-tauri/src/listener.rs`

- `Mutex<ListenerState>` с полями:
  - `current: Option<InputBinding>`
  - `pressed: HashSet<Key>` (для combo-detection клавиатуры)
  - `mode: Mode::Normal | Mode::Capturing`
- Spawn thread в `setup`, внутри `rdev::listen(callback)`
- Callback:
  - **Normal**: на `KeyPress`/`ButtonPress` обновляет `pressed` или сразу матчит mouse → если совпадает с `current` → `app.emit("toggle-mute", ())`
  - **Capturing**: первый `KeyPress` (с накопленными модификаторами) или `ButtonPress` → строит `InputBinding`, `emit("input-captured", binding)`, переключается обратно в Normal с новым current
- Anti-double-fire: после match выставляет cooldown 200ms

### 3. Rust: Tauri commands

**Новый файл:** `src-tauri/src/commands.rs`

```rust
#[tauri::command] fn get_shortcut(state: ...) -> Option<InputBinding>
#[tauri::command] fn set_shortcut(binding: InputBinding, state: ...) -> Result<(), String>
#[tauri::command] fn start_capture(state: ...)
#[tauri::command] fn cancel_capture(state: ...)
```

`set_shortcut` пишет на диск + обновляет `ListenerState.current`.

### 4. Rust: подключение в `lib.rs`

- `Cargo.toml`: `rdev = "0.5"`
- `lib.rs`:
  - `.manage(Arc<Mutex<ListenerState>>)`
  - `.invoke_handler(tauri::generate_handler![get_shortcut, set_shortcut, start_capture, cancel_capture])`
  - В `setup`: load shortcut с диска → spawn listener thread

### 5. IPC unblock для remote domain

**Файл:** `src-tauri/tauri.conf.json`

```json
"app": {
  "security": {
    "capabilities": ["default"],
    "dangerousRemoteDomainIpcAccess": [
      {
        "domain": "__APP_HOSTNAME__",
        "windows": ["main"],
        "enableTauriAPI": true
      }
    ]
  }
}
```

**Capability extension:** `src-tauri/capabilities/default.json` — добавить `core:event:default` чтобы фронт мог `listen()`. Custom commands регистрируются автоматически в default capability через `generate_handler!`.

### 6. CI: подстановка hostname

**Файл:** `.github/workflows/release-desktop.yml`

Новый step перед `tauri-action`:

```yaml
- name: Inject hostname into IPC allowlist
  shell: bash
  run: |
    sed -i "s|__APP_HOSTNAME__|${{ secrets.APP_HOSTNAME }}|" src-tauri/tauri.conf.json
```

### 7. Frontend: Tauri detection

**Новый файл:** `frontend/src/utils/tauri.ts`

```ts
export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;
```

### 8. Frontend: расширение HotkeyCard

**Файл:** `frontend/src/components/HotkeyCard.tsx`

- Если `isTauri()`:
  - Capture идёт через Tauri (`invoke('start_capture')` + `listen('input-captured', ...)`)
  - На select binding'а — `invoke('set_shortcut', {binding})`
  - Display формат: `Ctrl+Shift+M`, `Mouse Side 4`, `Mouse Right`
- Иначе — текущий `keydown`-подход (для браузера сохраняется)

### 9. Frontend: глобальный listener для toggle

**Файл:** `frontend/src/App.tsx`

```ts
useEffect(() => {
  if (!isTauri()) return;
  let unlistenFn: (() => void) | undefined;
  listen('toggle-mute', () => handleToggleSelfMute()).then(fn => { unlistenFn = fn; });
  return () => unlistenFn?.();
}, [handleToggleSelfMute]);
```

В Tauri-режиме отключить старый `useGlobalShortcut`, иначе двойной toggle.

### 10. Frontend: 2 distinct sounds

**Новый файл:** `frontend/src/audio/feedback-sounds.ts`

Через Web Audio (без бинарных ассетов):

```ts
// Mute (off): 880 → 440 Hz descending, sine, 80ms, peak gain 0.15
// Unmute (on): 440 → 880 Hz ascending, sine, 80ms, peak gain 0.15
export function playMuteSound() { ... }
export function playUnmuteSound() { ... }
```

Подключить в `handleToggleSelfMute` (App.tsx) — играть до/после `setSelfMuted`.

Использует `ensureRemoteAudioContext()` из `audio/remote.ts` (уже есть).

### 11. Auto-tag-desktop: smart tag

**Файл:** `.github/workflows/auto-tag-desktop.yml`

Изменить логику:

```
read current_version from tauri.conf.json
if tag v$current_version exists on remote:
    bump patch
    update Cargo.toml + tauri.conf.json
    commit
new_tag = v$current_version (or v$bumped_version)
push tag
dispatch release-desktop
```

Это позволит вручную бампить minor/major (`0.1.9 → 0.2.0`) — workflow увидит `v0.2.0` отсутствует, отметит без бампа.

### 12. Релиз

1. Локально: bump `Cargo.toml` + `tauri.conf.json` → `0.2.0` (вместе с фичей в одном коммите)
2. `git push origin master`
3. `auto-tag-desktop` видит `v0.2.0` отсутствует → тегает → dispatch
4. `release-desktop` собирает NSIS + `latest.json`
5. Юзеры на v0.1.9 получают update при следующем старте

## Известные риски

- **Антивирусы**: rdev — low-level hooks, могут флагать как keylogger. Defender обычно ОК. Если жалобы — code signing (EV cert ~$200/год, отдельный заход).
- **rdev на Windows**: работает с user-account, admin не нужен. Linux/macOS не релевантно (билдим только Windows).
- **Conflict с in-window hotkey**: если оба listener'а ловят одну комбинацию → двойной toggle. Решение: в Tauri отключить frontend `useShortcut` (см. шаг 9).
- **Capture mode UX**: первый press во время capture — финализирует binding. Если юзер случайно ткнул не туда, нужен `cancel_capture` (Esc или клик в UI).
- **Mouse buttons на ноутбуке**: тачпад без extra-buttons → mouse mode бесполезен, но keyboard остаётся.

## Оценка времени

| Этап | Время |
|---|---|
| Rust core (1-4) | 30-40 мин |
| IPC + CI (5-6) | 10 мин |
| Frontend (7-10) | 30-40 мин |
| Workflow smart tag (11) | 10 мин |
| Релиз (12) | 5 мин + CI |

Total: ~1.5 ч + ожидание сборки.

## Открытые вопросы для ревью

1. **Sound design**: устраивают синтез (880↔440 Hz sine glide) или нужны реальные .wav (которые тоже надо где-то взять)?
2. **Capture cancel UX**: Esc + клик-вне или только клик?
3. **Default shortcut в Tauri**: оставить `Ctrl+Shift+M` как сейчас, или сделать "не задано" по умолчанию (юзер сам выберет)?
4. **Conflict resolution**: если юзер выбрал биндинг, который коллизирует с системным (например, Win+L), мы всё равно ловим до системы? rdev перехватывает, но это может ломать UX.
5. **Audio output**: играть звук в системе (speakers) или в нашем remote audio context (который может быть подключён к специфичному device)? Сейчас план — system default через AudioContext.
6. **Где хранить sound enable/disable toggle**: в HotkeyCard или AudioCard?

## Review 2026-05-02

### Короткий вывод

Базовый план жизнеспособный, но его стоит немного упростить и поправить в местах Tauri v2 ACL/remote IPC. Главная развилка: если требование "кнопки мыши как hotkey" остаётся обязательным, `rdev` оправдан; если достаточно только клавиатурных глобальных shortcut'ов, официальный `tauri-plugin-global-shortcut` проще, безопаснее по поддержке и меньше похож на keylogger. В текущем скоупе написано "любая клавиша/кнопка мыши", поэтому я бы оставил `rdev`, но делал бы максимально маленький Rust-слой.

### Что поправить в основе плана

1. **Remote IPC в Tauri v2 лучше делать через capability `remote.urls`, а не через `dangerousRemoteDomainIpcAccess`.**
   В Tauri v2 capability управляет доступом webview к IPC, а remote origin задаётся прямо в capability через `remote: { urls: [...] }`. Для текущего `src-tauri/capabilities/default.json` это проще:

   ```json
   {
     "identifier": "default",
     "description": "Default desktop capability for the main window",
     "windows": ["main"],
     "remote": {
       "urls": ["https://__APP_HOSTNAME__/**"]
     },
     "permissions": ["core:default"]
   }
   ```

   Тогда шаг 5 лучше заменить на правку capability-файла, а CI-step должен подставлять hostname именно там. `core:default` уже включает `core:event:default`, так что отдельно добавлять `core:event:default` не нужно.

2. **Custom commands не стоит считать "автоматически разрешёнными" без проверки.**
   `generate_handler!` регистрирует команды, но Tauri v2 ACL всё равно завязан на capabilities/permissions. Если после прототипа `invoke('set_shortcut')` упадёт по ACL, нужен минимальный app permission-файл для `get_shortcut`, `set_shortcut`, `start_capture`, `cancel_capture` и ссылка на него из default capability. Это лучше добавить в план как явную проверку на первом Tauri-прогоне.

3. **Можно убрать часть сложности с `start_capture`/`input-captured`.**
   Проще и надёжнее: frontend включает режим capture через `start_capture`, Rust сам сохраняет пойманный binding на диск и обновляет `current`, а событием возвращает уже сохранённое значение. Тогда после `input-captured` frontend только обновляет UI/store и не вызывает отдельный `set_shortcut`. `set_shortcut` оставить для Reset/Clear и возможного импорта из UI. Это убирает гонку "captured, но save не прошёл".

4. **Модель binding лучше сразу сделать сериализуемой и frontend-friendly.**
   Вместо хранения `rdev::Key` напрямую в публичном JSON лучше завести свой DTO:

   ```rust
   #[serde(tag = "kind", rename_all = "camelCase")]
   enum InputBinding {
       Keyboard { keys: Vec<String> },
       Mouse { button: String },
   }
   ```

   Внутри listener'а можно маппить DTO в `rdev::Key/Button`. Так JSON не будет зависеть от формата enum'ов `rdev`, а frontend проще форматирует display.

5. **Нужно явно выбрать поведение для одиночных клавиш.**
   План говорит "любая клавиша", но текущий frontend не позволяет modifier-only, а `rdev` технически позволит поймать `A`, `Space`, `Ctrl` и т.п. Для mute toggle лучше разрешить:
   - keyboard combo: модификаторы + обычная клавиша;
   - одиночные mouse buttons;
   - одиночные keyboard keys только из allowlist (`F13-F24`, возможно `Pause`, `Insert`) или после подтверждения.

   Это сильно снижает шанс случайно повесить mute на букву при наборе текста.

6. **`rdev::listen` не перехватывает системное действие, а только слушает.**
   Поэтому формулировку про `Win+L` стоит поправить: `listen` не должен блокировать системный shortcut. Он может увидеть событие и успеть toggle'нуть mute перед блокировкой экрана, но не "перехватит" его в смысле отмены. Для отмены/consume нужен `grab` с `unstable_grab`, но это не нужно для v0.2.0 и увеличит риск.

7. **Звук лучше привязать к фактическому новому состоянию, а не к намерению toggle.**
   `handleToggleSelfMute` может сначала снять deafen и затем поменять self-muted. Чтобы не перепутать звук, стоит вычислить `nextMuted` один раз, применить состояние, затем играть `playMuteSound()` если `nextMuted === true`, иначе `playUnmuteSound()`. Опциональный toggle звука лучше держать в `AudioCard`, потому что это audio feedback, а не настройка hotkey.

8. **Smart tag workflow полезен, но это отдельный инфраструктурный change.**
   Его можно оставить в v0.2.0, но он не зависит от hotkey/sounds. Если хочется снизить риск релиза, сделать отдельным коммитом до фичи: сначала workflow, потом feature commit с ручным bump до `0.2.0`.

### Что можно сделать проще

- Не добавлять `dangerousRemoteDomainIpcAccess`; ограничиться `capabilities/default.json` с `remote.urls`.
- Не добавлять `core:event:default`; текущий `core:default` уже покрывает `listen/unlisten/emit/emit_to`.
- Сохранение binding делать на Rust side сразу в capture callback, а `set_shortcut` использовать только для reset/manual updates.
- Не пытаться на v0.2.0 блокировать конфликтующие системные shortcut'ы; только предупреждать/не разрешать заведомо плохие комбинации.
- Не добавлять `.wav` ассеты до пользовательской жалобы на синтез: Web Audio glide достаточен для первого релиза и не добавляет asset pipeline.

### Рекомендованный обновлённый skeleton

1. `shortcut.rs`: DTO `InputBinding`, load/save в app config dir, mapping DTO <-> rdev.
2. `listener.rs`: один listener thread, normal/capturing state, cooldown, save-on-capture.
3. `commands.rs`: `get_shortcut`, `set_shortcut` для reset/manual, `start_capture`, `cancel_capture`.
4. `lib.rs`: manage state, load shortcut, spawn listener, invoke handler.
5. `capabilities/default.json`: добавить `remote.urls` для `https://__APP_HOSTNAME__/**`; проверить invoke ACL на реальном desktop build.
6. Frontend: `isTauri`, Tauri capture path в `HotkeyCard`, `listen('toggle-mute')` в `App`, отключение browser `useGlobalShortcut` в Tauri.
7. Sounds: Web Audio helpers, вызов по фактическому `nextMuted`.
8. Workflow smart tag: лучше отдельным коммитом или хотя бы отдельным PR/частью релизной подготовки.

### Источники ресёрча

- Tauri v2 Capability reference: https://v2.tauri.app/reference/acl/capability/
- Tauri v2 Core permissions: https://v2.tauri.app/reference/acl/core-permissions/
- Tauri v2 Global Shortcut plugin: https://v2.tauri.app/plugin/global-shortcut/
- `@tauri-apps/plugin-global-shortcut` JS API: https://tauri.app/reference/javascript/global-shortcut/
- `rdev` crate docs: https://docs.rs/rdev/latest/rdev/
