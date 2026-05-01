# Voice Hub — план упрощения

> **Статус: выполнен.** Phase 1 (cookie auth + Tauri remote URL), Phase 2
> (Janus → embedded pion SFU), Phase 3 (coturn → embedded pion/turn) сделаны.
> Phase 4 (TLS внутрь Go) не делали — Caddy остаётся. Документ — историческая
> запись принятых решений.

Цель: **один Go-бинарь** делает всё (auth, статика, signaling, SFU, TURN). Tauri — тонкая
обёртка над remote URL, без секретов в бинаре. Минимум контейнеров, минимум кода,
минимум секретов.

## Контекст

- Один пользователь (я). Multi-user / accounts / migrations не нужны.
- Один общий логин/пароль на входе — гейт против рандомов.
- Сценарий: 3–10 человек, audio-only, одна постоянная комната, self-hosted.

## Целевая архитектура

```
Caddy (TLS, опц. — Phase 4 убирает)
  └─ voice-hub-server (single Go binary)
       ├─ session auth (HttpOnly signed cookie)
       ├─ static /  (web/)
       ├─ /api/login, /api/logout, /api/config, /api/ice-config
       ├─ /ws       — signaling (JSON over WebSocket)
       ├─ pion SFU  — RTP forwarding (audio Opus)
       └─ pion TURN — relay сервер (HMAC short-term creds)
```

Tauri: грузит `https://APP_HOSTNAME/` напрямую. Webview сохраняет cookie между
запусками — login один раз. В бинаре только hostname.

**Решения после ревью + ресёрча:**
- TURN не выкидываем (риск на симметричном NAT). Но и coturn не держим:
  встраиваем `pion/turn` в тот же Go-процесс. Один shared HMAC secret.
- Phase 2 (SFU) стартуем с форка `pion/example-webrtc-applications/sfu-ws`
  (~332 LoC канонический шаблон) — не пишем с нуля.
- Auth-cookie 80 LoC оставляем как есть (gorilla/securecookie ничего не даёт).
- LiveKit / ion-sfu обходим (ion-sfu мёртв с 2022).
- Caddy оставляем (Phase 4 — only ideological cleanup).

---

## Phase 1 — auth + чистый Tauri (1–2 часа)

Цель: один логин/пароль на входе, ноль секретов в Tauri-бинаре.

### 1.1 Backend: cookie session
- `POST /api/login` (form: `user`, `password`) → проверка против `APP_AUTH_USER` /
  `APP_AUTH_PASSWORD` → ставит HttpOnly `session` cookie (HMAC-signed, 30 дней).
- `POST /api/logout` → clear cookie.
- Middleware `requireAuth`: принимает cookie ИЛИ Basic Auth (Basic оставляем для
  обратной совместимости и health-проверок).
- Rate limiter применить к `/api/login`.
- Cookie secret: `APP_SESSION_SECRET` env (random 32 bytes). Если не задан — fail-fast.

### 1.2 Web login page
- `web/login.html` — форма POST `/api/login`. Редирект на `/` при успехе.
- В `web/app.js`: при `401` от любого fetch — редирект на `/login.html`.

### 1.3 Tauri: remote URL, без секретов
- `tauri.conf.json`: `app.windows[0].url = "https://${APP_HOSTNAME}/"`.
  `frontendDist` не нужен (статика хостится backend-ом).
- `src-tauri/src/lib.rs`: удалить `get_app_config`, `cfg_str/cfg_int/cfg_opt`,
  `option_env!` секреты целиком. Оставить только `tauri::Builder::default().run(...)`.
- `web/app.js`: убрать ветку `if (window.__TAURI__) invoke(...)` — везде `fetch('/api/config')`.

### 1.4 CI `release-desktop.yml`
- Убрать парсинг `secrets.PROD_ENV`.
- Бейкать в env шага build только `APP_HOSTNAME` (не секрет, можно в `vars`).
- Убрать `ROOM_ID`, `ROOM_PIN`, `TURN_USERNAME`, `TURN_PASSWORD`, `JANUS_WS_URL`,
  `STUN_URL`, `TURN_URL` — эти переменные больше не используются на стадии build.

**Проверка Phase 1:**
- Web: открыть `/`, увидеть login → залогиниться → попасть в комнату.
- Tauri: запустить exe → видим login → залогинились → cookie сохранилась →
  перезапустили → сразу в комнате.
- `strings voice-hub-desktop.exe | grep -E 'turn|room-secret|PIN'` — ничего.

---

## Phase 1.5 (опц.) — убрать Basic Auth, оставить только cookie

Сейчас middleware принимает cookie ИЛИ Basic — это переходный костыль. После
Phase 1.2 все веб-юзеры идут через login form. Удаление Basic упрощает mental
model, цена — `curl -u user:pass` перестаёт работать (для скриптов нужно сначала
`POST /api/login` и сохранять cookie).

- Убрать ветку `BasicAuth()` из `authenticated()` в `main.go`.
- Убрать `WWW-Authenticate` уже убран — больше нечего удалять.
- `/healthz` остаётся без auth — это публичный health endpoint.

---

## Phase 2 — Janus → pion SFU в Go-процессе (3–5 дней)

**Стартовая точка — fork `pion/example-webrtc-applications/sfu-ws`.**
Канонический ~332 LoC SFU с JSON-WS signaling и trickle ICE. Под наш сценарий
(audio-only, одна комната) выкидываем видео-транссивер и keyframe-ticker → ~200 LoC.

Цель: один Go-бинарь = signaling + SFU. Минус контейнер, минус 1300 строк JS,
минус `ROOM_PIN`/`ROOM_ID`, минус кастомный `.jcfg`.

### 2.1 Backend
- `go get github.com/pion/webrtc/v4`.
- `internal/sfu/`: `Room` (map `userID → *Peer`), `Peer` (PeerConnection +
  локальные RTP-треки для форвардинга).
- WebSocket endpoint `/ws` (auth через cookie):
  - Сообщения JSON: `{type: "join"}`, `{type: "offer", sdp}`, `{type: "answer", sdp}`,
    `{type: "ice", candidate}`, `{type: "leave"}`, server-side `{type: "peer-joined", id}`,
    `{type: "peer-left", id}`, `{type: "speaking", id, on}`.
- На `OnTrack` от publisher-а — создать local `TrackLocalStaticRTP` для каждого
  существующего peer-а, форвардить RTP через `WriteRTP`. На новых peer-ов —
  ренегошиэйт offer (или использовать перезамощённый pre-allocated transceivers).
- VAD: server-side не критично, можно client-side через WebAudio (как сейчас).

### 2.2 Web
- Новый `web/sfu-client.js`: тонкий слой над `RTCPeerConnection` + WebSocket.
- Из `web/app.js` удалить janus-protocol: `janusSend`, `janusTransaction`,
  attach/detach handles, plugin events. ~1300 строк → ~300.
- DTLN/RNNoise/audio pipeline остаётся как есть.

### 2.3 Compose / config
- Удалить сервис `janus` из `docker-compose.prod.yml`, директорию `deploy/janus/`.
- Caddyfile: убрать proxy `/janus-ws`. Добавить proxy `/ws` на backend (он же).
- Backend env: убрать `JANUS_WS_URL`, `ROOM_ID`, `ROOM_PIN`.
- Backend требует UDP-порт под RTP — настроить `pion` на фиксированный диапазон,
  открыть в Docker (`ports: ["10000-10100:10000-10100/udp"]`), как сейчас Janus.

**Проверка Phase 2:**
- Один Go-процесс, один контейнер `app` + Caddy + Janus временно остаётся
  выключенным до фактического переключения. После переключения: контейнеры =
  `caddy` + `app` + `coturn` (Janus удалён).
- 3 человека в комнате, аудио идёт во все стороны, VAD-индикатор работает.
- `web/app.js` < 600 строк (было 1795).

---

## Phase 3 — coturn → embedded `pion/turn` v5 (2–4 часа)

После Phase 2 SFU уже в Go. TURN тоже переводим в тот же процесс.

- `go get github.com/pion/turn/v4` (модуль `v4`, проект v5; имя пакета `turn/v4`).
- Listener на UDP 3478, relay-диапазон UDP (49160–49200 как сейчас).
- Auth: `turn.LongTermTURNRESTAuthHandler(sharedSecret, logger)` — точно такой
  же HMAC-протокол, как у coturn `--use-auth-secret`.
- Backend на `/api/ice-config` (после cookie-auth) генерит:
  - `username = "{exp_unix_seconds}:{user_id}"`
  - `credential = base64(HMAC-SHA1(sharedSecret, username))`
  - TTL 1 час.
- Тот же `sharedSecret` живёт в env `TURN_SHARED_SECRET`, передаётся и в TURN
  handler-у, и в `/api/ice-config` генератор. Cleartext в env переменных
  сервера, **не баждается в клиент**.

### 3.1 Compose
- Удалить сервис `coturn` из `docker-compose.prod.yml`.
- Удалить директорию `deploy/coturn/`.
- Открыть UDP-порты `3478` и `49160-49200` на сервисе `app` (там, где Janus
  раньше открывал свои UDP). В dev `docker-compose.yml` тоже.

### 3.2 Backend
- Новый пакет `internal/turn/`: запуск pion/turn в горутине вместе с HTTP
  server-ом. Graceful shutdown.
- `/api/ice-config` (auth-protected): возвращает `[{urls:["stun:host:3478"]},
  {urls:["turn:host:3478?transport=udp"], username, credential}]`.
- Web/desktop клиент — fetch на `/api/ice-config` вместо `/api/config`
  ICE-блока. Креды живые час, рефреш при join.

**Итог Phase 3:**
- Один Go-процесс делает ВСЁ: auth + static + signaling + SFU + TURN.
- Контейнеров: `caddy` + `app`. Точка.
- Никаких статических TURN-кредов на клиенте.

---

## Phase 4 (по умолчанию пропускаем) — встроить TLS, прощай Caddy

ROI слабый. Caddy уже решает TLS + Let's Encrypt + access logs за нас. Вынос
ACME в Go экономит один контейнер ценой реализации логов и удобного конфига
руками. Имеет смысл только если важна именно идеологическая чистота
«один процесс».

Если делаем — берём `caddyserver/certmagic`, не голый `acme/autocert`:
- `certmagic.HTTPS([]string{"example.com"}, mux)` — одна строка.
- Устойчивее к сбоям renewal-а (HTTP-01 + TLS-ALPN-01 + DNS), OCSP stapling,
  graceful degradation. Autocert падал в прод-проблемах в 2018.
- Cert storage на диске (volume), automatic renewal.
- Compose редуцируется до одного сервиса (или systemd-юнит на bare VPS).

---

## Порядок и оценка

| Phase | Оценка     | Зависит от | Делаем?              |
|-------|------------|------------|-----------------------|
| 1     | 1–2 часа   | —          | Да (готово)          |
| 1.5   | 15 мин     | 1          | Опц.                 |
| 2     | 3–5 дней   | 1          | Да (главный шаг)     |
| 3     | 2–4 часа   | 2          | Да (embedded pion/turn) |
| 4     | 1 час      | 2 + 3      | По умолчанию нет     |

Начинаем с Phase 1, шаг 1.1 (backend cookie session).

## Изменения после ревью

Порядок изначально был `1 → 2 (drop TURN) → 3 (pion SFU) → 4 (autocert)`.
После ревью переставили: TURN-решение **после** замены Janus, потому что:
- До своего SFU нет данных по реальному ICE success rate.
- После своего SFU добавить HMAC TURN-creds — час работы.
- Удаление TURN до Phase 2 — это «гадание»; после — осознанный выбор.
