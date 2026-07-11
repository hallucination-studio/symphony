# Managed runtime pipeline

The only execution path is:

```text
Linear delegation
  -> Podium cursor polling and one dispatch
  -> Conductor HTTP lease
  -> one durable plan revision
  -> ordered Linear Sub Issues
  -> Performer execute turn
  -> verification commands + read-only Codex Gate
  -> child Done or one rework then Blocked
  -> parent Done after every child passes
```

Podium owns Linear OAuth, project selection, full pagination, polling
checkpoints, delegation epochs, dispatch dedupe, project bindings, labels, and
the scoped GraphQL proxy. Conductor never receives a Linear token.

Conductor owns one bound project/repository, `workflow.db`, plan revisions,
tasks, fenced attempts, waits, gate evidence, artifacts, Linear child
projection, and failure visibility. Performer is a one-shot process launched
with request/result files. The only turn kinds are `plan`, `execute`, and
`gate`.

The runtime transport is authenticated HTTP polling: report, command lease/ack,
and dispatch lease/ack. The report carries the current sanitized workflow view
and cached log tail. A stale lease or result changes nothing.

There is no graph scheduler, parallel branch, integration queue, or workflow
checkpoint group. Linear's polling cursor checkpoints are unrelated and remain
required for reliable issue intake.
