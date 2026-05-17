# Rules for AI agents

Repository is **public**. Every commit is visible.

## Never commit

- Real names, emails, phones, messenger handles
- Absolute home paths — use `~` or relative
- Real hosts / IPs of prod/dev servers — use placeholders
- `.env` contents, tokens, keys, passwords
- Output of `whoami`, `hostname`, `id`, `env`

## Doc style

- README, release notes, comments — signal only. Don't explain the obvious.
- No planning `*.md` files in the repo. Plans live in PRs/tickets.
- Before PR: grep for «not yet» / «TODO» on shipped features.

## Env naming

| Tier | Prefix |
|------|--------|
| App-level | `APP_*` |
| Subsystem | `<DOMAIN>_*` (≥2 vars) |
| Infra context | no prefix (`IMAGE_TAG`, `PUBLIC_IP`) |

Range pairs: `<NAME>_MIN` / `<NAME>_MAX`. Required vars have no defaults, crash on startup. Secrets only via env.

## Git

- Conventional commits (`feat:`, `fix:`, `chore(desktop):`) — `release-desktop.yml` parses the prefix.
- No `--amend` on published commits, no force-push to master.
- Don't tag manually — auto-tag bot handles it.
