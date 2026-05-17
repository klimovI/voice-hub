<p align="center">
  <img src="docs/logo.svg" alt="voice-hub" width="128" height="128">
</p>

# voice-hub

[![Latest release](https://img.shields.io/github/v/release/vibes-group/voice-hub?label=release&color=blue)](https://github.com/vibes-group/voice-hub/releases/latest)
[![Release Desktop](https://github.com/vibes-group/voice-hub/actions/workflows/release-desktop.yml/badge.svg)](https://github.com/vibes-group/voice-hub/actions/workflows/release-desktop.yml)
[![License](https://img.shields.io/github/license/vibes-group/voice-hub)](LICENSE)

Self-hosted голосовая комната для маленьких компаний. Заточена под игры: чистый звук, низкая задержка.

- одна постоянная комната, 3–10 человек
- WebRTC, embedded pion SFU + TURN в одном Go-процессе
- шумодав на RNNoise
- весь стейт в браузере, никаких аккаунтов

## Скачать (Windows)

⬇ **[Последний релиз](https://github.com/vibes-group/voice-hub/releases/latest)** → `Voice.Hub_<version>_x64-setup.exe`. Auto-update встроен.

## Локальная разработка

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

Открыть `http://localhost:8080`, зайти паролем `dev`.

Фронт с HMR отдельно:

```bash
docker compose -f docker-compose.dev.yml up -d app --build
cd frontend && npm install && npm run dev
```

## Production

Сервер + GitHub Actions + Caddy. Push в master → деплой. Детали — [DEPLOY.md](DEPLOY.md).

## Desktop (Tauri)

Tauri 2 обёртка в `src-tauri/`. Generic бинарь — сервер вводится при первом запуске.

Релиз: push в `src-tauri/**` автоматически тегается и публикуется в GitHub Releases. Подробнее — [UPDATER.md](UPDATER.md).

Локальная сборка:

```bash
cd src-tauri
cargo install tauri-cli --version '^2'
cargo tauri dev
```

## Структура

```
backend/   Go: auth + статика + /ws + pion SFU + pion TURN
frontend/  React + Vite
src-tauri/ Tauri 2 desktop shell
```

Дальше: [DEPLOY.md](DEPLOY.md) · [AGENTS.md](AGENTS.md) · [UPDATER.md](UPDATER.md).
