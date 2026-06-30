---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  project_slug: d17d2f7a038d
  api_key: $LINEAR_API_KEY
  required_labels:
    - codex
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

hooks:
  after_create: |
    rsync -a --delete \
      --exclude '.git' \
      --exclude '.env' \
      --exclude '.venv' \
      --exclude '.pytest_cache' \
      --exclude '__pycache__' \
      --exclude 'workspaces' \
      ../../ ./
  timeout_ms: 120000

agent:
  max_concurrent_agents: 10
  max_turns: 1
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---
You are working on a Linear issue in a prepared copy of the repository.

Issue: {{ issue.identifier }} - {{ issue.title }}
URL: {{ issue.url }}
State: {{ issue.state }}
Attempt: {{ attempt }}

For this smoke-test issue, create `SYMPHONY_SMOKE_RESULT.md` at the workspace root.
The file must contain the issue identifier and one sentence saying the Symphony worker reached Codex successfully.
Then stop. Do not modify Linear.
