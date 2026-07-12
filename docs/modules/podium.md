# Module baseline: `podium`

Status: implemented baseline, 2026-07-12. Linear business behavior remains
unchanged.

## Responsibility

Podium is the SaaS control plane and BFF. It retains all customer-facing
Linear, authentication, onboarding, binding, dispatch, proxy, health, and
operator-view behavior. It is the only service that holds Linear application
and user tokens, and it injects them server-side into proxy requests.

The simplification is inside the runtime channel and persistence shape. It does
not remove a Linear business flow or change the Web's visible onboarding and
managed-run behavior.

## Business behavior that remains fixed

- Session auth, PKCE/state, default and customer-owned Linear applications,
  actor/scope validation, refresh, reconnect, revoke, and cutover.
- Selected projects, full cursor pagination, polling checkpoints, delegation
  epochs, dispatch deduplication, blockers, project-scoped routing, and
  `symphony:conductor/<Name>-<public-id>` labels.
- Conductor enrollment, one active binding per project, replacement rules,
  proxy calls, health, smoke action, PostgreSQL transactions/CAS/advisory locks,
  and sanitized browser responses.
- Managed-runs response fields consumed by the Web: conductor/project/binding/
  runtime group presentation, policy revision, profiles, run id/issue/state,
  active task, latest reason, plan version/revision, approval status, thread id,
  work items, task state, likely files, gate status/score, rubric summary,
  threshold, provenance, acceptance-catalog links, and artifact references.

`policy_revision` and `plan_version` are durable revision values projected from
Conductor. An empty `profiles` object is allowed when no runtime profile
registry is needed; it does not erase plan/evidence version history.

## Runtime HTTP contract

The authenticated runtime API is polling-only:

```text
POST /api/v1/runtime/dispatches/lease
POST /api/v1/runtime/dispatches/ack
POST /api/v1/runtime/commands/lease
POST /api/v1/runtime/commands/ack
POST /api/v1/runtime/report
```

Dispatch lease/ack keeps the existing routing and deduplication semantics.
Command lease/ack is the single delivery path for the Web-required control
operations:

```text
project.configure
project.unconfigure
project.prepare_installation
project.activate_installation
smoke.check
```

Commands are `queued | leased | completed | failed`, leased for five minutes,
and fenced by an integer token. Leasing selects the oldest queued or expired
command transactionally. A stale ack returns `409` and changes nothing. The
runtime report is authoritative for observed binding state and includes the
current sanitized log tail, local Codex configuration summary, and retained
plan/gate evidence summaries.

## Explicit removals

Delete the socket route, registration, tasks, presence/wake path, install
`socket_url`, `podium_socket_url`, socket dependencies, `dispatch.available`, the
in-memory dispatch queue, `human.answered`, historical `log.fetch`/log-chunk
transport, and duplicate smoke outbox/retry layers. Delete only the runtime
profile/config registry; keep policy/plan revision and evidence projections in
the Conductor-owned report. Remove `runtime_groups` as an independent ownership
table; migrate its stable id into the Conductor/binding record without dropping
customer data.

The Web still reads its current routes and report shape. Removing an unused
transport is not permission to remove a visible Web action or error state.

## Data and security baseline

The hard cutover starts the runtime/control-plane schema fresh; no old runtime
rows are read or migrated. `runtime_group_id` remains a stable presentation
alias on the Conductor/binding response, not a separately owned runtime-group
table. Runtime command and dispatch rows have transactional lease/fence fields.
Secrets never enter reports, logs, Linear, browser responses, or install
scripts. Errors retain category and actionable summary after sanitization.

## Migration and exit gate

1. Add command lease/expiry/reclaim/ack/fence contract coverage.
2. Move smoke result validation into command ack and make report state
   authoritative.
3. Switch Conductor to report -> command -> dispatch polling.
4. Remove socket/config/log-fetch/runtime-group/profile-registry sources and
   initialize the fresh schema without old runtime rows; preserve policy/plan
   revision and evidence fields for new runs.
5. Re-run OAuth, pagination/checkpoint/epoch, dispatch, binding, label, proxy,
   cutover, health, smoke, and secret-boundary behavior checks.

The local slice is complete when a fresh runtime can enroll, bind, receive
smoke and project commands, lease a parent dispatch, and report failures over
HTTP polling without any socket or direct-token path remaining. PostgreSQL
cutover and real OAuth remain environment verification work.
