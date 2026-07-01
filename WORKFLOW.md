---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  project_slug: a91b3f7117c7
  api_key: $LINEAR_API_KEY
  required_labels:
    - codex2
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
    git clone --shared --no-hardlinks ../.. .
  timeout_ms: 120000

agent:
  max_concurrent_agents: 10
  max_turns: 20
  max_retry_backoff_ms: 300000

codex:
  command: codex app-server
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---
You are working on a Linear issue.

Issue: {{ issue.identifier }} - {{ issue.title }}
URL: {{ issue.url }}
State: {{ issue.state }}
Description: {{ issue.description or 'No description provided.' }}
Attempt: {{ attempt }}

Implement the issue in this workspace. Follow repository instructions, run focused tests, and use available workflow tools to update Linear when useful.
