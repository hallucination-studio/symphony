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
   blockers, and Managed Runs capacity.
5. Podium idempotently queues one dispatch.
6. The project's Conductor leases the dispatch over outbound runtime
   authentication.
7. Conductor commits or resumes one durable managed run for the delegated issue.

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

The turn request names `turn_kind` as `plan` or `work_item`. A plan turn returns
a structured plan payload and does not change files. A work-item turn executes
exactly one accepted work item and returns a structured `WorkItemResult`.

Every request and result carries the same fenced turn context: `run_id`,
`work_item_id` when applicable, `policy_revision`, `plan_version`, `lease_id`,
`fencing_token`, and `turn_id`. Performer rejects an invalid request context and
echoes the accepted context in its result. Conductor rejects a missing, stale, or
mismatched result context before applying the result to durable work-item state.

Conductor prepares runtime homes, request files, result files, logs, leases, and
fencing. Performer never leases dispatches, writes Linear directly, or decides
terminal managed-run state.

## Planning

The planner receives the delegated issue, structured project context, current
managed-run state, policy limits, and acceptance inputs. Its output is a proposal,
not product fact.

Before acceptance, Conductor validates the plan: work items must be bounded,
acyclic, scoped to likely files, verifiable through RED/GREEN commands, safe in
their parallelization claims, and covered by a complete Definition-of-Done
rubric.

The accepted plan is immutable for execution. If implementation needs a new file
scope, dependency, acceptance criterion, or human decision, the backend returns a
plan-revision request. Conductor records a new plan version only after approval
and keeps prior versions for audit.

## Execution

Conductor selects the next dependency-ready work item. A work item becomes
ready only when its dependencies are Done, its file scope is present, and
runtime capacity is available.

The executor receives the work item, accepted plan version, likely touched
files, RED command, GREEN commands, and any verified upstream outputs explicitly
listed as inputs. It may modify implementation files within scope and report
evidence. It cannot change plan topology, policy, verification verdicts, Linear
terminal state, or durable managed-run state directly.

Every result includes changed files, planned/unplanned classification,
undeclared files, RED/GREEN evidence, acceptance results, blocker details, plan
revision payload when applicable, and notes.

## Verification

Conductor independently verifies work-item results before moving a Linear child
issue to Done. Verification checks file impact, declared scope, RED/GREEN
evidence, acceptance criteria, secrets, checkpoint commands, and result schema.

Command verification uses a disposable worktree with mutation detection after
gate execution. This is intentionally not OS-level read-only enforcement.

Failed verification leaves the work item out of Done, records a sanitized
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

A run is complete only when all active work items are Done or explicitly
canceled by approved revision, checkpoints passed, final Definition-of-Done
rubric is recorded, changed files and verification evidence are visible,
residual risks are listed, and the Linear parent summary is current.

Failures are handled only when the sanitized reason appears in durable state,
operator logs, and the relevant Linear projection.
