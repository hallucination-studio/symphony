# Workflow acceptance matrix

| Contract | Evidence |
| --- | --- |
| Linear polling discovers delegated work with durable cursor/epoch state | Podium Linear reconciliation state and dispatch records |
| A parent run is idempotent and fenced | `workflow.db` run/attempt rows and `TurnContext` |
| Plan metadata and approval are durable | `plan_revisions`, Linear parent projection |
| Every plan task becomes a Linear Sub Issue and executes in order | `tasks.linear_issue_id`, task state transitions |
| Verification commands and one Codex Gate are both required | `gate_evidence`, command output, Codex provenance |
| Gate failure allows one rework and then blocks | `tasks.rework_count`, `runs.latest_reason=gate_failed` |
| Runtime waits remain visible and resume only after the Linear state reopens | `runtime_waits`, parent/Sub Issue comment and state |
| Logs and sanitized failure reasons are operator-visible | per-attempt `performer.log`, Conductor/Podium reports |

Cross-model acceptance, checkpoint groups, branch joins, dependency graphs,
and a second acceptance scheduler are deliberately absent.
