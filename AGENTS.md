# Rules for AI agents

This repository is **public**. Treat every commit as visible.

## Never commit

- Real names, emails, phone numbers, messenger handles
- Absolute home paths (`/home/<user>/...`, `C:\Users\<name>\...`) — use `~` or relative
- Real hostnames / IPs of prod, dev, or test VPS — use placeholders (`your-host.example.com`, `<server-ip>`)
- `.env` contents, tokens, keys, passwords, SSH keys — even as "examples"
- Output of `whoami`, `hostname`, `id`, `env`
- Personal asides like "(me)", "on my laptop"

## Doc style

- README, release notes, comments — signal only. Don't explain the obvious, don't apologise, don't pre-empt unasked questions.
- No planning `*.md` files in the repo. Plans live in PR descriptions or tickets.
- Delete a feature's planning doc once it ships.
- Before PR: grep for "not yet" / "TODO" on shipped features and refresh.

## Security

- The Tauri binary contains no secrets and no hardcoded hosts. Host is entered on first launch and stored in the OS keychain. ICE/TURN credentials and signaling URL come from the backend after login.
- Updater signing private key (`~/.tauri/voice-hub.key`) lives only in GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`.
- `tauri.conf.json` → `plugins.updater.pubkey` is a public key — safe to commit.

## Env naming

| Tier | Prefix | When |
|------|--------|------|
| App-level | `APP_*` | service-wide: `APP_ADDR`, `APP_HOSTNAME`, `APP_WEB_DIR`, `APP_ADMIN_PASSWORD`, dev toggles (`APP_PPROF`, `APP_ALLOW_INSECURE`) |
| Subsystem | `<DOMAIN>_*` | ≥2 vars in one domain: `TURN_*`, `UDP_*` |
| Infra context | no prefix | set from outside the app: `IMAGE_TAG`, `PUBLIC_IP`, `VIBES_NET_SUBNET` |

Range pairs: `<NAME>_MIN` / `<NAME>_MAX`. Required vars have no defaults and crash on startup. Secrets only via env, never as flags, never logged.

## Git / releases

- Conventional commits (`feat:`, `fix:`, `chore(desktop):`, ...) — `release-desktop.yml` parses the prefix for changelog sections.
- No `--amend` on published commits, no `--force-push` to `master`.
- Don't tag releases manually unless you changed `src-tauri/**` — the auto-tag bot handles it.
