# Deploy

> ⚠️ Репо публичный. В коммитах — только плейсхолдеры (`<origin-ip>`, `<your-host>`). Секреты — в GitHub Secrets и `/opt/voice-hub/.env`.

VPS + GitHub Actions. CI собирает образ, пушит в `ghcr.io`, по SSH деплоит на сервер. На сервере — только compose-стек (Caddy + app).

## Архитектура

```
internet ──HTTPS/WSS──▶ Cloudflare (proxy) ──▶ Caddy (Origin Cert) ──▶ app (8080)
internet ──UDP 3478, 10101-10200, 49160-49199 ──────────────────────────▶ app (bypass CF)
```

UDP-only voice (как у Discord). Сети без UDP не поддерживаются.

## Требования

- VPS: 1 vCPU, 1 ГБ RAM, 15 ГБ — хватает на 3-5 audio-only.
- Debian/Ubuntu, root по SSH-ключу.
- Домен на Cloudflare.

## Bootstrap (один раз)

```bash
scp deploy/server-bootstrap.sh root@<origin-ip>:/tmp/
ssh root@<origin-ip> 'bash /tmp/server-bootstrap.sh'
```

Скрипт ставит docker, sysctl tuning, UFW (SSH + voice UDP), создаёт `deploy` user, настраивает CF-only firewall на TCP 443 (DOCKER-USER chain + systemd + weekly cron). Идемпотентен.

Сгенерируй deploy SSH key (отдельный от личного), pubkey в `~deploy/.ssh/authorized_keys` на сервере, privkey пойдёт в GitHub Secret `DEPLOY_SSH_KEY`.

## Cloudflare

DNS:
- A `<your-host>` → `<origin-ip>`, **proxied** (orange cloud).

SSL/TLS:
- Mode = **Full (strict)**.
- Edge Certificates → **Always Use HTTPS** = on.
- Origin Server → **Create Certificate** (15 лет, RSA 2048, hostname = `<your-host>` или `*.<zone>`). Скопировать cert и key.
- Origin Server → **Authenticated Origin Pulls** = on (zone-wide). CF будет подписывать соединения к origin своим клиентским cert; Caddy верифицирует.

На сервер — origin cert/key + CF origin-pull CA (для AOP):
```bash
curl -sSL https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem -o cf-origin-ca.pem
scp origin.crt origin.key cf-origin-ca.pem root@<origin-ip>:/opt/voice-hub/deploy/
ssh root@<origin-ip> '
  chmod 600 /opt/voice-hub/deploy/origin.crt /opt/voice-hub/deploy/origin.key
  chmod 644 /opt/voice-hub/deploy/cf-origin-ca.pem
  chown deploy:deploy /opt/voice-hub/deploy/origin.* /opt/voice-hub/deploy/cf-origin-ca.pem
'
```

Порядок включения AOP: сначала CF dashboard toggle ON, потом push с Caddyfile-блоком `client_auth`. Обратный порядок ломает сайт (Caddy требует cert, CF ещё не шлёт).

## GitHub Actions secrets

| Secret | Значение |
|---|---|
| `DEPLOY_HOST` | literal IPv4 origin сервера. SSH target (CF не проксирует port 22) **и** `PUBLIC_IP` для pion (NAT1To1 + TURN relay address). Workflow валидирует. |
| `DEPLOY_SSH_KEY` | приватный ключ deploy-юзера (целиком, с BEGIN/END) |
| `DEPLOY_HOST_KEY` | host-key origin для known_hosts. Получить: `ssh-keyscan -t ed25519 <origin-ip>` |
| `APP_HOSTNAME` | публичный домен (CF-проксируемый) |
| `APP_ADMIN_PASSWORD` | пароль админа (`openssl rand -base64 24`) |
| `TAURI_SIGNING_PRIVATE_KEY` | подпись desktop-релизов |

После первого `build` job — на github.com/`<owner>`?tab=packages образу `voice-hub-app` поменять visibility на **Public**, иначе сервер не сделает `docker pull` без авторизации.

## Auto-managed серверные секреты

Бэкенд сам генерит и хранит в volume `app_data` (`/app/data/`, mode 600): HMAC для cookie, HMAC для TURN creds, argon2id хеш connection password. Логика — в `backend/internal/auth/`. Backup не нужен: потеря volume = перелогин + ротация connection password.
