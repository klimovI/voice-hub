# Deploy

Деплой инфра — в [`vibes-group/infra`](https://github.com/vibes-group/infra).

## Поток

```
push в master
  → build.yml: build+push ghcr.io/vibes-group/voice-hub-app:<sha>
  → uses vibes-group/infra/.github/workflows/deploy.yml
```

## Порты

```
HTTPS/WSS → Caddy → voice-hub-app:8080
UDP 3478, 10101-10200, 49160-49199 → voice-hub-app
```

## Secrets

| Secret | Источник | Назначение |
|---|---|---|
| `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_HOST_KEY` | org | reusable workflow infra |
| `VOICE_HUB_HOST` | org | публичный домен (`APP_HOSTNAME`) |
| `APP_ADMIN_PASSWORD` | repo | пароль админа |
| `TAURI_SIGNING_PRIVATE_KEY` | repo | подпись desktop-релизов |
