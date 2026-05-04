# Deploy

> ⚠️ Репо публичный. Никаких реальных IP, хостов, паролей, токенов — только плейсхолдеры. Секреты живут в GitHub Secrets и `/opt/voice-hub/.env` на сервере.

Прод-стек: VPS + GitHub Actions. CI собирает образ, пушит в `ghcr.io`, по SSH деплоит на сервер. На самом сервере крутится только compose-стек (Caddy + app) — никаких сорсов, никаких билдов.

## Архитектура

```
internet ──HTTPS/WSS────────────▶ Caddy (auto-TLS) ──▶ app (10.200.200.1:8080)
internet ──UDP  3478, 10000-11000, 49000-49500 ───────▶ app (host network)
```

- Caddy (стоковый `caddy:2-alpine`) фронтит HTTPS по 443, выпускает Let's Encrypt cert через TLS-ALPN-01
- App запущен в `network_mode: host` — публикация ~1500 UDP портов через docker NAT слишком хрупка (race в network attach при `compose up`, тяжёлый iptables). Caddy остаётся на bridge и достукивается через `host.docker.internal:8080` (= bridge gateway `10.200.200.1`)
- App слушает HTTP на `10.200.200.1:8080` — это IP bridge gateway изнутри хоста; снаружи недостижим (нет listener на публичном интерфейсе)
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

# Docker + log rotation. `userland-proxy: false` обязателен — мы пробрасываем
# 1500+ UDP портов (ICE + TURN), а на каждый пробрасываемый порт docker
# поднимает отдельный docker-proxy процесс (~5MB). На 1 GB боксе это OOM
# на старте. С отключённым userland-proxy docker делает чистый iptables DNAT,
# процессов на порт ноль.
curl -fsSL https://get.docker.com | sh
mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "userland-proxy": false
}
EOF
systemctl restart docker

# Kernel tuning для WebRTC/HTTP/3/TURN. Без него quic-go и pion получают
# дефолтные 208 KiB UDP rcvbuf — Caddy ругается на старте, RTP дропает под
# burst. Kernel-buffer вне cgroup, container mem_limit'ы не трогаются.
cat > /etc/sysctl.d/99-voice-hub.conf <<'EOF'
net.core.rmem_max = 7340032
net.core.wmem_max = 7340032
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 5000
vm.swappiness = 10
EOF
sysctl --system

# Non-root deploy user в группе docker
useradd -m -s /bin/bash -G docker deploy

# UFW: app в host network, поэтому media UDP должны быть явно разрешены.
# 80/443/22 предполагаются уже открытыми. App :8080 НЕ открываем — он
# биндится только к 10.200.200.1 (docker bridge gateway), снаружи невидим.
ufw allow 3478/udp comment "voice-hub stun/turn"
ufw allow 10000:11000/udp comment "voice-hub ICE"
ufw allow 49000:49500/udp comment "voice-hub TURN relay"

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
| `DEPLOY_HOST_KEY` | pin host-key сервера для known_hosts (защита от MITM). Получить: `ssh-keyscan -t ed25519 <host>` |
| `APP_HOSTNAME` | публичный домен. Используется только backend-deploy (Caddy + `APP_HOSTNAME` env). Desktop-релиз больше его не читает — бинарь generic, host вводит пользователь. |
| `PROD_ENV` | остальной `.env` целиком (см. формат выше) |
| `TAURI_SIGNING_PRIVATE_KEY` | приватный ключ для подписи desktop-релизов |

После первого успешного `build` — на github.com/<owner>?tab=packages для образа `voice-hub-app` поменять visibility на **Public**, чтобы сервер мог `docker pull` без авторизации. Иначе нужен `docker login` на сервере под PAT.

## Workflow

`.github/workflows/deploy.yml` запускается на push в master:

1. Build: app → `ghcr.io/<owner>/voice-hub-app:<sha>` (long sha tag only)
2. Sync deploy files: scp `docker-compose.prod.yml` и `Caddyfile` в `/opt/voice-hub/`
3. Write .env on host: пишет `/opt/voice-hub/.env` из `PROD_ENV` secret (`chmod 600`), полностью перезаписывая прежний
4. Pull & restart: `docker compose pull && docker compose up -d --remove-orphans && docker image prune -af` (последний шаг чистит старый образ — без него каждый деплой кидает ~155MB на диск)

Откатить: на сервере `docker compose pull` с конкретным sha-тегом, либо ревертнуть коммит и пушнуть.

Поменять одну переменную: обнови `PROD_ENV` в GitHub UI, затем либо запусти workflow вручную (Actions → Deploy → Run workflow), либо подожди следующего пуша.

## DNS гайд

Для домена нужна forward A-запись на IP сервера. Cloudflare работает в режиме **DNS only** (grey cloud). Orange cloud (proxy) ломает TLS-ALPN-01 challenge и UDP для TURN — для WebRTC бесполезен без CF Spectrum (платно). Для friends-scale — DNS only, защитой от DDoS не заморачиваемся.

DuckDNS работает, но его NS периодически таймаутят CAA-запросы Let's Encrypt — Caddy ретраит, но cert может выпускаться 10-30 минут.

## Local-hosted альтернативы (не используем)

Когда-то рассматривали Tailscale / Cloudflare Tunnel / port forwarding с домашнего ПК. Все требуют friends что-то ставить или принимают деградацию latency через сторонний TURN. Для always-on не подходит — нужен включённый ПК. Решили: VPS дешевле (~200₽/мес) и набивно проще.
