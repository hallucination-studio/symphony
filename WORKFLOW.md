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

acceptance:
  enabled: true
  mode: block_done
  minimum_score: 3
  require_findings_for_score_3: true
  auto_retry_on_fail: true
  todo_state: Todo
  implementation_state: In Progress
  review_state: In Review
  done_state: Done
  task_type_label: performer:type/task
  gate_type_label: performer:type/gate
  evidence_type_label: performer:type/evidence
  gate_pending_label: performer:gate/pending
  gate_passed_label: performer:gate/passed
  gate_pass_with_findings_label: performer:gate/pass-with-findings
  gate_failed_label: performer:gate/failed
  score_label_prefix: performer:score/

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

Implement the issue in this workspace. Follow repository instructions and run focused tests.

Acceptance gates are enabled by default. Before handing off, update the Linear issue description with concrete evidence fields named exactly:
- `Implementation summary:`
- `Test commands and exact output:`
- `Remaining risks:`

Do not move the issue to Done yourself. Leave it active after implementation evidence is written; Performer will move it to review, create or use gate child issues, create evidence child issues, and close the tree if acceptance passes.

If Performer posts a runtime permission or sandbox error and labels the issue `performer:error`, do not retry silently. A human must inspect the error, fix or approve the environment, then comment this exact command on the Linear issue to resume:

`/symphony approve-runtime-error {{ issue.identifier }}`
