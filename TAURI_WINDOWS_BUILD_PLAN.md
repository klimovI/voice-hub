# Tauri Windows Build Plan

Цель: собирать Windows desktop app из Linux/WSL для этого репозитория.

## Текущее состояние

Готово:

- `rustup`, `rustc`, `cargo` работают
- targets: `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`
- `cargo-xwin 0.22.0`, `tauri-cli 2.11.0`
- `clang` + `clang-cl` shim (`~/.local/bin/clang-cl -> /usr/bin/clang`), `lld-link`, `llvm-rc`
- `src-tauri/icons/icon.ico` + desktop PNGs (256/128/32)
- `tauri.conf.json` → `bundle.targets = ["nsis"]`, GUI subsystem (`#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`)
- кросс-сборка проходит, артефакты:
  - `src-tauri/target/x86_64-pc-windows-msvc/release/audio-room-desktop.exe` (PE32+ GUI)
  - `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Audio Room_0.1.0_x64-setup.exe`

## Build команда

```bash
cd src-tauri
CARGO_HTTP_TIMEOUT=600 CARGO_NET_RETRY=10 \
  $HOME/.cargo/bin/cargo tauri build \
  --runner $HOME/.cargo/bin/cargo-xwin \
  --target x86_64-pc-windows-msvc
```

## Что проверить на Windows-машине

- запуск `audio-room-desktop.exe` показывает окно с фронтендом из `web/`
- NSIS installer ставит app, ярлык работает
- `get_app_config` подхватывает env: `JANUS_WS_URL`, `ROOM_ID`, `ROOM_PIN`, `STUN_URL`, `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD`

## Возможные доработки

- code signing (нужен Windows host либо custom `bundler.windows.sign_command`)
- кастомные иконки вместо сгенерённого placeholder'а
- глобальный shortcut через `tauri-plugin-global-shortcut`
- доп. bundle target: `msi` (требует WiX) если нужен MSI
