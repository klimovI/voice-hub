# Tauri Windows Build

Сборка Windows desktop app: CI через GitHub Actions (основной путь) + локальная кросс-сборка из Linux/WSL.

## CI Release (GitHub Actions)

Workflow: `.github/workflows/release-desktop.yml`. Runner — `windows-latest`, нативный MSVC, без xwin. Триггеры:

- `push` тега `v*` → собирает и создаёт Release с `.exe`
- `workflow_dispatch` → ручной запуск из UI с произвольным тегом (для теста)

### Релиз новой версии

```bash
# 1. Обновить версию
$EDITOR src-tauri/tauri.conf.json   # version: "0.1.1"
git commit -am "bump: 0.1.1"
git push origin master

# 2. Создать тег и запушить
git tag -a v0.1.1 -m "Release 0.1.1"
git push origin v0.1.1
```

GH Actions подхватит push тега → ~5-10 мин → новый Release на https://github.com/klimovI/voice-hub/releases с двумя файлами: `voice-hub-desktop.exe` (standalone) и `Voice Hub_0.1.1_x64-setup.exe` (NSIS installer).

### Стоимость

Repo публичный → unlimited GH Actions minutes. Storage — Releases без ограничений.

## Локальная сборка (Linux/WSL → Windows)

### Текущее состояние

Готово:

- `rustup`, `rustc`, `cargo` работают
- targets: `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`
- `cargo-xwin 0.22.0`, `tauri-cli 2.11.0`
- `clang` + `clang-cl` shim (`~/.local/bin/clang-cl -> /usr/bin/clang`), `lld-link`, `llvm-rc`
- `src-tauri/icons/icon.ico` + desktop PNGs (256/128/32)
- `tauri.conf.json` → `bundle.targets = ["nsis"]`, GUI subsystem (`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`)
- кросс-сборка проходит, артефакты:
  - `src-tauri/target/x86_64-pc-windows-msvc/release/voice-hub-desktop.exe` (PE32+ GUI)
  - `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Voice Hub_0.1.0_x64-setup.exe`

### Build команда

```bash
cd src-tauri
CARGO_HTTP_TIMEOUT=600 CARGO_NET_RETRY=10 \
  $HOME/.cargo/bin/cargo tauri build \
  --runner $HOME/.cargo/bin/cargo-xwin \
  --target x86_64-pc-windows-msvc
```

## Что проверить на Windows-машине после сборки

- запуск `voice-hub-desktop.exe` показывает окно с фронтендом из `web/`
- NSIS installer ставит app, ярлык работает
- `get_app_config` подхватывает env: `JANUS_WS_URL`, `ROOM_ID`, `ROOM_PIN`, `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD`

## Возможные доработки

- code signing (нужен Windows host либо custom `bundler.windows.sign_command`)
- кастомные иконки вместо сгенерённого placeholder'а
- глобальный shortcut через `tauri-plugin-global-shortcut`
- доп. bundle target: `msi` (требует WiX) если нужен MSI
