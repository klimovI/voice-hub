# Tauri Windows Build

Сборка Windows desktop app: CI через GitHub Actions (основной путь) + локальная кросс-сборка из Linux/WSL.

## CI Release (GitHub Actions)

Workflow: `.github/workflows/release-desktop.yml`. Runner — `windows-latest`, нативный MSVC, без xwin. Триггеры:

- `push` тега `v*` → собирает и создаёт Release с NSIS installer
- `workflow_dispatch` → ручной запуск из UI с произвольным тегом (для теста)
- авто-триггер через `auto-tag-desktop.yml` при push в `src-tauri/**` (см. [UPDATER.md](UPDATER.md))

### Релиз новой версии

Обычно делается автоматом: правишь `src-tauri/**` → push в master → bot бампит patch + создаёт тег. Вручную, если нужно major/minor:

```bash
# bump версии в src-tauri/Cargo.toml + tauri.conf.json (синхронно)
git commit -am "release(desktop): v0.2.0"
git tag v0.2.0
git push origin master --tags
```

GH Actions → ~5-10 мин → новый Release с `Voice Hub_<version>_x64-setup.exe` (NSIS) + `latest.json` для updater. Подписывается из `TAURI_SIGNING_PRIVATE_KEY` secret.

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

- запуск `voice-hub-desktop.exe` открывает webview на `APP_BASE_URL` (по умолчанию `http://localhost:8080/`), показывает login-форму
- после логина cookie сохраняется между запусками — повторный пуск сразу попадает в комнату
- NSIS installer ставит app, ярлык работает
- `strings voice-hub-desktop.exe | grep -E 'turn|secret|password'` — ничего секретного в бинаре

## Возможные доработки

- code signing (нужен Windows host либо custom `bundler.windows.sign_command`)
- кастомные иконки вместо сгенерённого placeholder'а
- глобальный shortcut через `tauri-plugin-global-shortcut`
- доп. bundle target: `msi` (требует WiX) если нужен MSI
