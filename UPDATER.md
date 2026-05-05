# Desktop Auto-Update

Tauri shell обновляется через `tauri-plugin-updater`. Фронт обновляется сам через backend deploy.

## Когда тегать релиз

Только при изменениях:
- `src-tauri/**` (Rust код, `tauri.conf.json`, capabilities, иконки, deps)
- `release-desktop.yml`

Изменения только в `frontend/**` или `backend/**` — НЕ тегать. Юзеры получат свежий фронт через backend deploy при следующем открытии (или F5).

## Bootstrap (один раз)

### 1. Сгенерить ключи подписи

```bash
cd src-tauri
cargo install tauri-cli --version "^2" --locked
cargo tauri signer generate -w ~/.tauri/voice-hub.key
```

На запрос password — пустой (Enter). CI использует только `TAURI_SIGNING_PRIVATE_KEY`; зашифрованный ключ ломает сборку. Получишь:
- `~/.tauri/voice-hub.key` — приватный (СЕКРЕТ)
- `~/.tauri/voice-hub.key.pub` — публичный

### 2. Pubkey в config

```bash
cat ~/.tauri/voice-hub.key.pub
```

Содержимое в `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Закоммить.

### 3. Privkey в GitHub Secrets

`TAURI_SIGNING_PRIVATE_KEY` = содержимое `~/.tauri/voice-hub.key` целиком.

## Релизный flow

```bash
# bump version в Cargo.toml + tauri.conf.json (синхронно)
git commit -am "release(desktop): vX.Y.Z"
git tag vX.Y.Z
git push origin master --tags
```

## Shell-vs-front compatibility

Если фронт начинает вызывать новый Tauri IPC command, которого нет в установленном shell:
- Мелочь — feature-detect через `try/catch` на `invoke()`.
- Критично — `getVersion()` из `@tauri-apps/api/app`, блокировать UI с "Обнови приложение" если ниже требуемой.

Порядок выкатки: сначала shell-релиз с новой командой, дождаться, что юзеры обновились, потом катить фронт, который её зовёт.
