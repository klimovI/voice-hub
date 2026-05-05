# Deploy

> ⚠️ Репо публичный. В коммитах — только плейсхолдеры (`<origin-ip>`, `<your-host>`). Секреты — в GitHub Secrets и `/opt/voice-hub/.env`.

VPS + GitHub Actions. CI собирает образ, пушит в `ghcr.io`, по SSH деплоит на сервер. На сервере — только compose-стек (Caddy + app).

## Архитектура

```
internet ──HTTPS/WSS─────▶ Caddy (Let's Encrypt) ──▶ app (8080)
internet ──UDP 3478, 10101-10200, 49160-49199 ───▶ app
```

Caddy сам выписывает и обновляет TLS-сертификат у Let's Encrypt. CDN не используется — RKN блокирует Cloudflare edge IP, поэтому держим origin открытым.

UDP-only voice (как у Discord). Сети без UDP не поддерживаются.

## Требования

- VPS: 1 vCPU, 1 ГБ RAM, 15 ГБ — хватает на 3-5 audio-only.
- Debian/Ubuntu, root по SSH-ключу.
- Домен с A-записью на IP сервера.

## Bootstrap (один раз)

```bash
scp deploy/server-bootstrap.sh root@<origin-ip>:/tmp/
ssh root@<origin-ip> 'bash /tmp/server-bootstrap.sh'
```

Скрипт ставит docker, sysctl tuning, UFW (SSH + voice UDP), создаёт `deploy` user. Идемпотентен.

Сгенерируй deploy SSH key (отдельный от личного), pubkey в `~deploy/.ssh/authorized_keys` на сервере, privkey пойдёт в GitHub Secret `DEPLOY_SSH_KEY`.

## DNS

- A `<your-host>` → `<origin-ip>`. Без CDN-проксирования (на Cloudflare — grey cloud).

## GitHub Actions secrets

| Secret | Значение |
|---|---|
| `DEPLOY_HOST` | literal IPv4 origin сервера. SSH target **и** `PUBLIC_IP` для pion (NAT1To1 + TURN relay address). Workflow валидирует. |
| `DEPLOY_SSH_KEY` | приватный ключ deploy-юзера (целиком, с BEGIN/END) |
| `DEPLOY_HOST_KEY` | host-key origin для known_hosts. Получить: `ssh-keyscan -t ed25519 <origin-ip>` |
| `APP_HOSTNAME` | публичный домен, A-запись на `DEPLOY_HOST` |
| `APP_ADMIN_PASSWORD` | пароль админа (`openssl rand -base64 24`) |
| `TAURI_SIGNING_PRIVATE_KEY` | подпись desktop-релизов |

После первого `build` job — на github.com/`<owner>`?tab=packages образу `voice-hub-app` поменять visibility на **Public**, иначе сервер не сделает `docker pull` без авторизации.

## Auto-managed серверные секреты

Бэкенд сам генерит и хранит в volume `app_data` (`/app/data/`, mode 600): HMAC для cookie, HMAC для TURN creds, argon2id хеш connection password. Логика — в `backend/internal/auth/`. Backup не нужен: потеря volume = перелогин + ротация connection password.
