# Desktop Auto-Update

Tauri shell обновляется через `tauri-plugin-updater`. Фронт обновляется сам через backend deploy (Dockerfile embed'ит `frontend/dist`, `deploy.yml` пушит на каждый master).

## Архитектура

```
push frontend/** или backend/**  ─▶ deploy.yml ─▶ VPS  ─▶ свежий фронт мгновенно
push src-tauri/** + tag v*       ─▶ release-desktop.yml ─▶ GitHub Release ─▶ updater клиент тянет
```

App на старте делает `updater().check()` против `latest.json` в GitHub Releases. Если версия больше — silent download + install + relaunch.

## Когда тегать релиз

Только при изменениях:
- `src-tauri/**` (Rust код, `tauri.conf.json`, capabilities, иконки, deps)
- `release-desktop.yml`

При изменениях только в `frontend/**` или `backend/**` — НЕ тегать. Юзеры получат обновление через backend deploy, окно перезагрузится при следующем открытии (или вручную F5 / Ctrl+R).

## Bootstrap (один раз)

### 1. Сгенерить ключи подписи

Локально:

```bash
cd src-tauri
cargo install tauri-cli --version "^2" --locked   # если ещё нет
cargo tauri signer generate -w ~/.tauri/voice-hub.key
```

Когда команда спросит password — оставь пустым (просто Enter). CI использует
только `TAURI_SIGNING_PRIVATE_KEY`; если ключ зашифрован паролем, сборка упадёт
на этапе подписи. Получишь два файла:
- `~/.tauri/voice-hub.key` — приватный ключ (СЕКРЕТ)
- `~/.tauri/voice-hub.key.pub` — публичный ключ

### 2. Положить pubkey в config

```bash
cat ~/.tauri/voice-hub.key.pub
```

Скопируй содержимое и замени `REPLACE_WITH_PUBKEY_FROM_cargo_tauri_signer_generate` в `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

Закоммить.

### 3. Положить privkey в GitHub Secrets

Repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Значение |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | содержимое `~/.tauri/voice-hub.key` целиком |

`APP_HOSTNAME` уже должен быть (используется в `deploy.yml`).

## Релизный flow

```bash
# bump version в Cargo.toml + tauri.conf.json (синхронно)
# например 0.1.8 → 0.1.9

git commit -am "release(desktop): v0.1.9"
git tag v0.1.9
git push origin master --tags
```

`release-desktop.yml` соберёт NSIS, подпишет, выложит в GitHub Release вместе с `latest.json`. Запущенные клиенты увидят новую версию при следующем check — зависит от того, когда юзер откроет app.

## Откат

Удалить релиз в GitHub UI → клиенты не увидят новую версию. Уже обновившиеся остаются на новой — для них откат = выпустить v0.1.10 с прежним кодом.

## Edge case: shell нужен новее, чем deployed фронт

Если новая фича фронта требует custom Rust command, которого ещё нет в установленном shell:
- Фронт делает feature-detect через `try/catch` на `invoke()` — для мелочи.
- Для критичного — добавить в фронт чек версии shell через `getVersion()` из `@tauri-apps/api/app`, и блокировать UI с message "Обнови приложение" если меньше требуемой.

Сейчас shell экспортит несколько IPC-команд для hotkey UI (`get_shortcut`, `set_shortcut`, `clear_shortcut`, `start_capture`, `cancel_capture`). Если фронт начнёт вызывать новую команду — добавь её сначала в shell, выпусти релиз, потом катай фронт.

## Troubleshooting

- **"Updater error: signature mismatch"** — pubkey в config не соответствует privkey в secrets. Перегенерь или сверь.
- **Updater молчит** — `latest.json` отсутствует в Release или endpoint URL неверный. Проверь `https://github.com/klimovI/voice-hub/releases/latest/download/latest.json` в браузере.
- **Установка падает** — installer mode `passive` требует UAC consent. Если юзер запретил — fail. Сменить на `quiet` (требует admin install) или оставить — пусть ретраит.
