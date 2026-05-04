# Deploy

> ⚠️ Репо публичный. Никаких реальных IP, хостов, паролей, токенов — только плейсхолдеры. Секреты живут в GitHub Secrets и `/opt/voice-hub/.env` на сервере.

Прод-стек: VPS + GitHub Actions. CI собирает образ, пушит в `ghcr.io`, по SSH деплоит на сервер. На самом сервере крутится только compose-стек (Caddy + app) — никаких сорсов, никаких билдов.

## Архитектура

```
internet ──HTTPS/WSS─────────────▶ Caddy (auto-TLS) ──▶ app (8080)
internet ──UDP  3478, 10101-10200, 49160-49200 ────────▶ app
```

- Caddy (стоковый `caddy:2-alpine`) фронтит HTTPS по 443, выпускает Let's Encrypt cert через TLS-ALPN-01
- WebRTC media и TURN-relay идут напрямую в app по UDP, в обход Caddy
- Voice — UDP-only. Сети, где UDP заблокирован, не поддерживаются (как у Discord). TCP/TLS-фолбэка для TURN нет
- app = один Go-бинарь: auth + static + /ws signaling + pion SFU (RTP forwarding) + pion TURN UDP (HMAC short-term creds). Janus и coturn убраны

## Требования

- VPS: 1 vCPU, 1 ГБ RAM, 15 ГБ — хватает для 3-5 юзеров audio-only
- Debian/Ubuntu, доступ root по SSH
- Домен с forward A на IP (DuckDNS работает, но иногда флапает CAA-таймаутами; платный домен на ~200₽/год надёжнее)
- Открытый исходящий UDP на сервере и у клиентов

## Bootstrap сервера (один раз)

```bash
# swap, чтобы 1 ГБ не упирался в OOM
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab

# Docker + log rotation
curl -fsSL https://get.docker.com | sh
mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'EOF'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
EOF
systemctl restart docker

# Non-root deploy user в группе docker
useradd -m -s /bin/bash -G docker deploy

# SSH: только по ключу, root login по ключу (паролем — нет)
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload ssh

# Каталог под compose-стек
mkdir -p /opt/voice-hub/deploy && chown -R deploy:deploy /opt/voice-hub
```

Сгенерируй deploy SSH key (отдельный от личного), pubkey в `/home/deploy/.ssh/authorized_keys`, privkey пойдёт в GitHub Secret.

## `/opt/voice-hub/.env`

Файл провижится workflow'ом из GitHub secret `PROD_ENV` на каждом деплое — вручную трогать не нужно. Формат (single multi-line blob, который кладётся в `PROD_ENV`):

```
PUBLIC_IP=<внешний IP сервера для TURN>
APP_ADMIN_PASSWORD=<openssl rand -base64 24>
```

`APP_HOSTNAME` хранится в **отдельном** GH-секрете (`APP_HOSTNAME`) — workflow конкатенирует его в итоговый `.env` на сервере. В `PROD_ENV` его класть не нужно.

- `APP_ADMIN_PASSWORD` — пароль администратора. С ним заходит **только админ**, в UI генерит/ротирует connection password, который раздаёт пользователям. Утечка лечится одним кликом ротации, а не редеплоем.
- `PUBLIC_IP` — нужен pion/turn для генерации SDP с правильным relay-адресом.
- На сервере права `chmod 600` ставит сам workflow.
- Сохрани копию `PROD_ENV` в менеджер паролей: GitHub UI секреты не показывает после создания.

### Auto-managed секреты на сервере

Бэкенд сам генерит и хранит в volume `app_data` (`/app/data/`):

- `session.secret` — HMAC-ключ для подписи session cookie. Удаление файла = разлогинивает всех.
- `turn.secret` — HMAC-ключ для short-term TURN creds. Cleartext в клиент НЕ попадает.
- `connection-password.json` — argon2id-хеш connection password (плейн нигде не хранится).

Файлы создаются на первом старте, режим `0600`. Backup-ить смысла нет: потеря volume = все перелогинятся, админ переротирует connection password — больше ничего не теряется.

## Миграция со старой схемы (`APP_AUTH_USER`/`APP_AUTH_PASSWORD`)

1. В `PROD_ENV`: убери `APP_AUTH_USER` и `APP_AUTH_PASSWORD`, добавь `APP_ADMIN_PASSWORD=<значение>`.
2. Деплой. Все существующие сессии станут невалидны (формат cookie сменился) — все перелогинятся.
3. Зайди как админ → шестерёнка-ключ в правом верхнем углу → **Создать пароль** → скопируй блок «Сервер: … / Пароль: …» → раздай команде.

## GitHub Actions secrets

| Secret | Значение |
|---|---|
| `DEPLOY_HOST` | IP или домен сервера |
| `DEPLOY_SSH_KEY` | приватный ключ deploy-пользователя (целиком, с BEGIN/END) |
| `APP_HOSTNAME` | публичный домен. Используется только backend-deploy (Caddy + `APP_HOSTNAME` env). Desktop-релиз больше его не читает — бинарь generic, host вводит пользователь. |
| `PROD_ENV` | остальной `.env` целиком (см. формат выше) |
| `TAURI_SIGNING_PRIVATE_KEY` | приватный ключ для подписи desktop-релизов |

После первого успешного `build` — на github.com/<owner>?tab=packages для образа `voice-hub-app` поменять visibility на **Public**, чтобы сервер мог `docker pull` без авторизации. Иначе нужен `docker login` на сервере под PAT.

## Workflow

`.github/workflows/deploy.yml` запускается на push в master:

1. Build: app → `ghcr.io/<owner>/voice-hub-app:{latest,sha}`
2. Sync deploy files: scp `docker-compose.prod.yml` и `Caddyfile` в `/opt/voice-hub/`
3. Write .env on host: пишет `/opt/voice-hub/.env` из `PROD_ENV` secret (`chmod 600`), полностью перезаписывая прежний
4. Pull & restart: `docker compose pull && docker compose up -d --remove-orphans`

Откатить: на сервере `docker compose pull` с конкретным sha-тегом, либо ревертнуть коммит и пушнуть.

Поменять одну переменную: обнови `PROD_ENV` в GitHub UI, затем либо запусти workflow вручную (Actions → Deploy → Run workflow), либо подожди следующего пуша.

## DNS гайд

Для домена нужна forward A-запись на IP сервера. Cloudflare работает в режиме **DNS only** (grey cloud). Orange cloud (proxy) ломает TLS-ALPN-01 challenge и UDP для TURN — для WebRTC бесполезен без CF Spectrum (платно). Для friends-scale — DNS only, защитой от DDoS не заморачиваемся.

DuckDNS работает, но его NS периодически таймаутят CAA-запросы Let's Encrypt — Caddy ретраит, но cert может выпускаться 10-30 минут.

## Local-hosted альтернативы (не используем)

Когда-то рассматривали Tailscale / Cloudflare Tunnel / port forwarding с домашнего ПК. Все требуют friends что-то ставить или принимают деградацию latency через сторонний TURN. Для always-on не подходит — нужен включённый ПК. Решили: VPS дешевле (~200₽/мес) и набивно проще.
