# Managed Run Runtime

## Purpose

The Symphony runtime path is a Conductor-owned Linear-native managed run. Podium
routes delegated Linear work and pushes runtime configuration. Performer runs
one fenced managed-run turn at a time. Linear is the operator projection and
collaboration surface.

This is the only runtime execution path. Legacy workflow runners, direct
Performer polling, graph schedulers, and standalone mode attempts are not
product paths.

## Intake

1. A Linear issue is delegated to the Symphony custom agent.
2. Podium's installation- and project-scoped poller discovers the issue through
   a full baseline or incremental scan.
3. Full cursor pagination transactionally records issue observations, delegation
   epochs, idempotency, dispatch rows, and resumable checkpoints.
4. Podium matches the active installation, Linear organization, stable project
   id, app user, selected scope, single-project Conductor binding, active state,
   and blockers.
5. Podium idempotently queues one dispatch.
6. The project's Conductor leases the dispatch over outbound runtime
   authentication.
7. Conductor commits or resumes one durable workflow run for the delegated issue.

Repeated polls cannot create duplicate dispatches, and a new dispatch for the
same issue requires a durably observed redelegation. Dispatch routing never uses
project labels or human assignee as scheduler truth.

## Project Runtime Boundary

One Conductor binds exactly one selected Linear project and one repository. A
project has at most one active Conductor. Multiple isolated Conductors may run
on the same host for different projects. Podium creates and owns the project
binding; the Conductor durably acknowledges the versioned project config before
dispatch is enabled.

Same-identity OAuth reauthorization rotates credentials without draining.
Different-identity application replacement drains Managed Runs and dispatches,
prepares every bound Conductor with the candidate app user identity, then
atomically switches the workspace installation. Active work never silently
changes application identity mid-run.

## Managed-Run Turns

Performer accepts only one-shot managed-run turns:

```bash
.venv/bin/performer --turn-request-path /path/turn-request.json --turn-result-path /path/turn-result.json
```

The turn request names `turn_kind` as `plan`, `execute`, or `gate`. A plan turn
returns a structured plan and does not change files. An execute turn changes
one ordered task. A gate turn is read-only and returns one `GateResult`.

Every request and result carries the same fenced turn context: `run_id`,
`task_id` when applicable, `attempt_id`, `fencing_token`, and `turn_kind`.
Performer rejects an invalid request context and echoes the accepted context in
its result. Conductor rejects a missing, stale, or mismatched result context
before applying it to durable task state.

Conductor prepares runtime homes, request files, result files, logs, leases, and
fencing. Performer never leases dispatches, writes Linear directly, or decides
terminal managed-run state.

## Planning

The planner receives the delegated issue and acceptance inputs. Its output is a
proposal, not product fact.

Before acceptance, Conductor validates the plan: tasks must be bounded, ordered,
scoped to likely files, and verifiable through declared commands.

The accepted plan is immutable for execution. If implementation needs a new file
scope, dependency, acceptance criterion, or human decision, the backend returns a
plan-revision request. Conductor records a new plan version only after approval
and keeps prior versions for audit.

## Execution

Conductor selects the next ordered task. A task becomes ready when its file
scope is present and the runtime profile is available.

The executor receives one accepted task, its likely touched files, acceptance
criteria, and verification commands. It may modify implementation files within
scope and report evidence. It cannot change plan topology, verification verdicts,
Linear terminal state, or durable workflow state directly.

Every result includes changed files, acceptance evidence, and blocker details.

## Verification

Conductor runs every declared verification command, then invokes one read-only
Codex Gate before moving the Linear Sub Issue to Done. Gate evidence keeps the
score, threshold, rubric, provenance, findings, and artifact references.

Failed verification leaves the task out of Done, records a sanitized
reason in durable state, logs it with correlation ids, and updates the relevant
Linear projection.

## Human And Runtime Waits

Managed-run work that needs operator input blocks the parent run or affected work
item with a concrete reason and required action. Comments provide context only;
Conductor state owns resume semantics.

Runtime approval, permission, and tool-input waits are separate runtime waits.
They are surfaced through work-item metadata and the product's runtime wait
projection, including `[Human Action]` child issues where that flow uses them.

## Completion

A run is complete only when every ordered task is Done, gate evidence and
artifacts are visible, residual risks are listed, and the Linear parent summary
is current.

Failures are handled only when the sanitized reason appears in durable state,
operator logs, and the relevant Linear projection.
