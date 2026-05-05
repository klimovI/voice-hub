# Workflow Conventions

## Trigger filters: prefer positive `paths`, avoid `paths-ignore`

When a workflow should only fire on changes to specific files/dirs, use a **positive `paths:` filter listing what triggers it**, not `paths-ignore:` listing what doesn't.

```yaml
# Good — explicit allowlist. New unrelated files (docs, plans, other workflows) never spuriously trigger this workflow.
on:
  push:
    branches: [master]
    paths:
      - 'backend/**'
      - 'frontend/**'
      - 'docker-compose.prod.yml'
      - 'deploy/**'
      - '.github/workflows/deploy.yml'
```

```yaml
# Brittle — must edit every time a new doc/file/workflow is added that shouldn't trigger.
on:
  push:
    branches: [master]
    paths-ignore:
      - 'src-tauri/**'
      - 'UPDATER.md'
      - '.github/workflows/auto-tag-desktop.yml'
      - '.github/workflows/release-desktop.yml'
```

### Why

- **Default-deny is safer than default-allow.** Forgetting to add a new path to a positive list means "no trigger" (loud — the workflow doesn't run, you notice). Forgetting to add to ignore-list means "spurious trigger" (silent — wasted CI time, unexpected redeploys, possible auto-tag loops).
- New docs / planning files / unrelated workflows added at the repo root never cause hidden side-effects.
- Onboarding: positive list answers "what changes does this workflow care about?" in one glance. Negative list requires reading both the list and knowing what's NOT on it.

### When `paths-ignore` is acceptable

Only when the inclusion set is genuinely "everything else" and the exclusion set is small + stable. Rare in practice — usually positive list wins.

## Other rules

- **`GITHUB_TOKEN`-driven pushes don't trigger downstream workflows.** Tag/branch pushes from `actions/checkout` + `git push` using the default token are silently ignored by other workflows' triggers (anti-loop policy). To dispatch a downstream workflow, use `gh workflow run` with `actions: write` permission, or use a PAT.
- **`[skip ci]` in commit message** suppresses workflows on **all** events (including tag push) for that commit. If you push a bump commit that creates a tag, `[skip ci]` will block both. Use actor checks (`if: github.actor != 'github-actions[bot]'`) instead for loop prevention.
- **Long-lived secrets in workflows**: name them clearly (`TAURI_SIGNING_PRIVATE_KEY`, not `KEY1`) and document where they live and rotation policy in the relevant `*.md` (e.g. `UPDATER.md`).
