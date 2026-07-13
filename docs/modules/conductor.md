# Module target: `conductor`

Status: ADR-0006 target boundary accepted on 2026-07-13; implementation is
tracked in `tasks/plan.md`.

## Responsibility

Conductor is the customer-side daemon for one bound Linear project and one
repository. It leases Podium dispatches over HTTP, keeps the durable sequential
workflow, starts installed Performer control/turn processes, projects ordered
Linear Sub Issues, runs verification commands, and reports a sanitized view to
Podium.

It is the only local process manager for Performer. It imports only
`performer_api` shared contracts. It must not import `performer`, a provider
SDK, provider-generated types, or implement a provider-specific controller.

## Target ownership

| Owner | Responsibility |
|---|---|
| `models.py`, `store.py` | SQLite workflow/evidence plus generic `performer_control_state` |
| `workflow_driver.py` | One bounded plan/execute/gate progression and Linear projection |
| `runtime.py` | Fenced request/result files, turn subprocess lifecycle, logs, result fencing |
| `performer_control.py` | Generic installed control-host supervision and `performer_api` protocol |
| `gate.py` | Declared commands plus selected-backend Gate combination |
| `linear.py` | Podium proxy operations |
| `conductor_podium_sync.py` | Reports, command polling, dispatch lease, smoke handling |
| `conductor_api.py`, `conductor_service.py` | Local API, composition, background tick |

## Performer process boundary

Conductor builds one immutable allowlisted backend environment for its
lifetime and passes it to the long-running Performer control host and all
short-lived turn processes. It may select HOME, optional provider-owned home
variables, and approved binary paths, but it does not interpret provider files
or provider SDK semantics.

The generic coordinator owns async process start, stream framing, heartbeat,
timeout, cancellation, exit, and safe log capture. A pending provider login
handle stays inside Performer. Conductor holds only a generic subprocess handle
and permits status/cancel while blocking conflicting config/Check/turn work.

## Readiness

The local `performer_control_state` is secret-free and bound to backend kind,
binding generation, capability version, and execution-policy hash. Startup or
identity mismatch resets current readiness to `unchecked` while preserving the
last sanitized Check evidence.

A non-ready plan/execute/gate does not create an attempt. The run blocks with a
generic actionable reason visible in SQLite, logs, Podium, and Linear. A
compatible manual Check resumes the exact prior phase once with a new fence.

## Canonical workflow

~~~text
planning -> awaiting_approval -> executing -> blocked | failed | done
todo -> in_progress -> in_review -> blocked | done
running -> waiting | succeeded | failed | stale
~~~

For one parent, Conductor executes only the first unfinished task. A child is
Done only after verification commands and the selected backend's read-only Gate
pass. One failed Gate reworks once; a second failure blocks task and parent.
The parent is Done only after every child is Done.

## Hard-cut rules

- Never add a CodexController, ClaudeController, provider SDK dependency, or
  provider response parser to Conductor.
- Never import Performer internals; shared contracts belong in `performer_api`.
- Remove credential slots, per-attempt provider-home materialization, provider
  config parsing/writes, and auth reconciliation.
- Preserve one automatic Gate rework, runtime waits, plan approval, fencing,
  durable logs, and visible sanitized failure reasons.
- Do not add DAG, parallel, branch/join, checkpoint-group, integration-queue,
  cross-model, dynamic-plugin, or second acceptance-scheduler behavior.
