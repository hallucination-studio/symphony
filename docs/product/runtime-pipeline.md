# Managed runtime pipeline

The only execution path is:

```text
Linear delegation
  -> Podium cursor polling and one dispatch
  -> Conductor private IPC dispatch lease and ACK
  -> one durable plan revision
  -> ordered Linear Sub Issues
  -> Performer execute turn
  -> verification commands + read-only selected-backend Performer Gate
  -> child Done or one rework then Blocked
  -> parent Done after every child passes
```

Podium owns Linear OAuth, the discovered project catalog, full pagination,
polling checkpoints, delegation epochs, dispatch dedupe, desired Conductor
bindings, labels, and the scoped GraphQL proxy. Project choice occurs only
inside Create Conductor together with repository choice; an active desired
binding is polling/dispatch eligibility. Conductor never receives a Linear
token.

Conductor owns one bound project/repository, `workflow.db`, plan revisions,
tasks, fenced attempts, waits, gate evidence, artifacts, Linear child
projection, and failure visibility. Conductor imports only `performer_api` and
launches installed Performer processes. A long-running control host owns
provider login/config/Check handles; each fenced turn remains a one-shot
request/result process. The only turn kinds are `plan`, `execute`, and `gate`.

Performer owns the internal backend interface/registry and provider SDK
adapters. Conductor never imports a provider SDK or provider-generated type.

Podium and each Desktop-managed Conductor exchange closed report, command, and
dispatch lease/ACK messages over that child's inherited private IPC channel.
There is no public listener or bearer secret. The report carries the current
sanitized workflow view and cached log tail. A stale lease or result changes
nothing.

There is no graph scheduler, parallel branch, integration queue, or workflow
checkpoint group. Linear's polling cursor checkpoints are unrelated and remain
required for reliable issue intake.
