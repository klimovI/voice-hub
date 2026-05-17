# Workflow конвенции

## Триггеры: позитивный `paths`, не `paths-ignore`

```yaml
on:
  push:
    branches: [master]
    paths:
      - 'backend/**'
      - 'frontend/**'
      - '.github/workflows/build.yml'
```

Default-deny: забыл путь — workflow молча не запустится (громко). Забыл в ignore — лишние срабатывания, auto-tag-петли (тихо).
