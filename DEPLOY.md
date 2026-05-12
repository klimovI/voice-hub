# Deploy

Деплой и инфра вынесены в [`vibes-group/infra`](https://github.com/vibes-group/infra). Здесь — только voice-hub-специфика.

## Поток

```
push в master
  → .github/workflows/build.yml: build+push ghcr.io/vibes-group/voice-hub-app:<sha>
  → uses vibes-group/infra/.github/workflows/deploy.yml@master
  → infra: scp compose+.env на сервер, docker compose pull && up -d, health poll
```

Полное описание сервера, layout `/opt/vibes/`, Caddy, bootstrap — в [infra/README.md](https://github.com/vibes-group/infra#readme).

## Сетевые требования

```
internet ──HTTPS/WSS─────▶ Caddy ──▶ voice-hub-app:8080
internet ──UDP 3478, 10101-10200, 49160-49199 ───▶ voice-hub-app
```

UDP-only voice (как у Discord). Сети без UDP не поддерживаются. CDN не юзаем — RKN блокирует Cloudflare edge IP, держим origin открытым.

## Secrets (этого репо)

| Secret | Источник | Назначение |
|---|---|---|
| `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_HOST_KEY` | org `vibes-group` | прокидываются в reusable workflow infra |
| `VOICE_HUB_HOST` | org `vibes-group` | публичный домен, идёт в .env как `APP_HOSTNAME` |
| `APP_ADMIN_PASSWORD` | repo | пароль админа (`openssl rand -base64 24`) |
| `TAURI_SIGNING_PRIVATE_KEY` | repo | подпись desktop-релизов (auto-tag-desktop.yml, release-desktop.yml) |

## Auto-managed серверные секреты

Бэкенд сам генерит и хранит в `/app/data/` (bind `/opt/vibes/voice-hub/data/` на хосте, mode 600): HMAC для cookie, HMAC для TURN creds, argon2id хеш connection password. Логика — `backend/internal/auth/`. Backup не нужен: потеря данных = перелогин + ротация connection password.
