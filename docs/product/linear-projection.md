# Linear projection

## Authority

Conductor's durable `workflow.db` is the execution source of truth. Linear is
the operator-visible projection and the source for observed plan-approval and
runtime-wait state changes. Podium owns OAuth, polling, delegation epochs,
blocker checks, bindings, labels, and the authenticated Linear proxy.

## Issue shape

One delegated parent maps idempotently to one run. A plan creates one ordered
Linear Sub Issue per task with an explicit `parent { id identifier }` relation.
Conductor executes only the first unfinished Sub Issue. Codex approval or tool
input waits may create a `[Human Action]` child for the exact affected parent or
Sub Issue.

Podium's active `blocks` relation check remains an intake concern: it prevents
leasing a delegated parent while its blocker is active. It is unrelated to the
removed Conductor task-dependency graph.

## Current visible projection

- Parent description: a concise plan block and lifecycle comments.
- Sub Issue: task objective, acceptance criteria, verification commands, file
  scope, state transition, and concise Gate result comment.
- Gate comment: pass/fail, score/threshold, command pass count, and whether
  one rework remains or the task is blocked.
- Runtime wait: sanitized reason and a recorded Linear action surface.

Plan revisions, catalogs, rubric/provenance, manifest/artifact references, and
full command evidence remain durable Conductor data. They are not currently
projected as a separate catalog/gate/artifact child-issue tree, nor rendered in
full by Podium Web.

## Recovery and safety

Repeated polls and restarts reuse the same run and child ids. A stale fenced
Performer result cannot advance state. Projection failures are recorded with a
sanitized reason and must remain visible in the relevant durable state and
operator log; browser and Linear projections never include secrets.
