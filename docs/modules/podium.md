# Module baseline: `podium`

Status: implemented code baseline, 2026-07-12. Linear business behavior is
preserved; real OAuth/Linear verification has not been run in this workspace.

## Responsibility

Podium is the SaaS control plane and BFF. It owns browser auth, Linear
application configuration and installations, selected projects, Conductor
enrollment/binding, polling reconciliation, dispatch routing, the server-side
Linear proxy, smoke checks, and the HTTP API consumed by Podium Web.

It is the only product role that holds Linear application or user tokens. Those
tokens are injected only into server-side proxy requests and never returned to
the browser or Conductor.

## Fixed business behavior

- Session auth, OAuth PKCE/state, default and customer-owned Linear app paths,
  actor/scope checks, token refresh, selected project access, and Linear
  installation cutover remain intact.
- Reconciliation remains cursor-paginated and checkpointed. Delegation epochs,
  dispatch deduplication, active binding/app-user routing, labels, and Linear
  blockers remain part of the dispatch decision.
- A delegated issue is never leased while it has an active Linear blocker.
  Failed/invalid live blocker checks fail closed and requeue the dispatch; a
  later completed reconciliation can restore a cleared dispatch.
- Podium retains the BFF routes and response shapes used by the Web app,
  including onboarding, bindings, runtime logs, smoke actions, and managed-run
  reports.

## Runtime ownership after the hard cut

The runtime channel is polling-only:

```text
Conductor HTTP report / command lease / dispatch lease
  -> Podium runtime API
  -> PostgreSQL durable state
```

There is no WebSocket transport or runtime socket compatibility layer. HTTP
reports update the retained runtime-presence TTL used by Web's online/heartbeat
views.

`runtime_groups` is deleted from the fresh PostgreSQL schema. Enrollment tokens
and managed-run views are keyed by `conductor_id`; proxy and smoke checks use
direct runtime-to-binding-to-workspace checks. API responses retain
`runtime_group_id` as the deterministic presentation alias
`group_{conductor_id}`. It is not a stored owner or routing key.

## Current module groups

| Area | Primary owners |
|---|---|
| App/API composition | `app.py`, `podium_routes_*`, `podium_state.py` |
| Linear auth/installations/projects | `linear_*`, `podium_routes_linear_*`, `podium_linear_*` |
| Bindings, labels, replacement | `podium_conductors.py`, `podium_project_*` |
| Polling and dispatch | `linear_reconciliation*`, `podium_dispatch.py` |
| Runtime/API/health/smoke | `podium_runtime.py`, `podium_routes_runtime_*`, `podium_smoke_*`, `podium_health.py` |
| PostgreSQL | `store/_postgres_*.py`, `postgres.py` |

The split is still broader than the desired end state. Do not merge modules
merely for a line count if that would mix OAuth, polling, proxy authorization,
or transaction ownership.

## Managed-run report contract

Conductor reports are normalized to Web's `work_items`,
`active_work_item_id`, and `backend_session_id` fields before Web consumes
them. The public managed-run route currently returns `policy_revision: 1` and
`profiles: {}`; it does not claim to expose a Codex configuration summary or
all local evidence fields.

## Hard-cut rules

- New PostgreSQL schema only: no old runtime-group or profile rows are read or
  migrated.
- Keep Linear OAuth/tokens and browser secret boundaries unchanged.
- Do not add a generic runtime protocol, outbox framework, WebSocket path,
  cross-model acceptance, or a second scheduler.
