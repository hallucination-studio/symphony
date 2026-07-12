# Linear projection

## Authority boundary

Conductor's durable `workflow.db` is the execution source of truth. Linear is
the operator-visible projection and the source of explicitly observed human
actions. Podium owns Linear OAuth, polling, delegation epochs, dispatch
eligibility, labels, and the authenticated GraphQL proxy. Conductor never holds
a direct Linear token.

Comments add context only. They never act as commands.

## Issue shape

One delegated parent issue maps idempotently to one run. An approved plan
creates one ordered Sub Issue per task, each with an explicit Linear parent
relationship. Conductor executes only the first unfinished Sub Issue.

```text
Parent business issue
  ├─ Sub Issue 1  -> verification commands + Codex Gate -> Done
  ├─ Sub Issue 2  -> verification commands + Codex Gate -> Done
  └─ [Human Action] runtime wait (only when Codex needs input)
```

There is no task dependency graph, `blocks` projection, branch, join,
checkpoint group, integration child, or comment-command protocol in the
Conductor workflow.

Active Linear blockers on the delegated parent remain a Podium intake concern:
Podium must not lease a dispatch while an active blocker exists, and must
reconsider the same dispatch when the blocker clears. This is unrelated to the
removed task-dependency graph.

## Visible lifecycle

- The parent carries concise plan, execution, gate, and terminal summaries.
- Each Sub Issue shows `todo`, `in_progress`, `blocked`, or `done` through its
  normal Linear state.
- A failed gate remains non-Done. One rework is allowed; the second failure
  blocks the task and parent with a concrete sanitized next action.
- A runtime approval or tool-input wait records a durable wait and may create a
  `[Human Action]` child. Completing that exact action resumes a fresh fenced
  attempt; comments alone do not resume work.
- Plan revisions, approval, risks, architecture decisions, open questions,
  acceptance catalog entries, command evidence, one Codex Gate result, score,
  rubric, threshold, provenance, manifest, and artifact references remain
  visible as compact projection metadata. They do not create another scheduler.

Every terminal or blocking projection carries the same sanitized fields as the
durable run: `error_code`, `sanitized_reason`, `action_required`, `retryable`,
and `next_action`.

## Idempotency and validation

Conductor stores each child issue id before later state changes. Repeated polls
or restart recovery reuse the same run, task, child, and fenced attempt. A
stale Performer result changes nothing. Before treating a child as projected,
Conductor validates its explicit `parent { id identifier }` relationship rather
than relying on title text or comments.

Projection failures are durable and visible in the parent/Sub Issue, local
structured log, and Podium managed-runs response. Projection data never
contains tokens, cookies, passwords, client secrets, or raw Codex credentials.
