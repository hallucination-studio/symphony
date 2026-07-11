# Spec: Minimal Polling Workflow

Status: approved for implementation as of 2026-07-12. This specification
replaces the expanded Managed Run design; real Linear/OAuth/Codex verification
remains environment-dependent.

## Objective

Symphony has one job: turn a delegated Linear parent issue into a sequence of
Linear sub-issues, let Codex implement them, require an acceptance gate for each
sub-issue, and complete the parent only after every gate passes.

Podium remains the customer-facing control plane and Web application. Podium
owns Linear OAuth, project selection, Conductor enrollment/binding, Linear
polling, dispatch, project labels, proxying, and operator views. Conductor owns
one bound repository, the sequential workflow, Performer processes, gates,
durable recovery, Linear sub-issue projection, and visible failures. Performer
runs one fenced Codex turn from a JSON request file to a JSON result file.

The design is deliberately not a general workflow engine, DAG scheduler,
multi-backend platform, cross-model acceptance platform, or compatibility layer.

## Assumptions Requiring Approval

1. Work sub-issues execute strictly in plan order. There is no dependency DAG,
   parallel group, capacity scheduler, per-task branch, or branch join.
2. One acceptance gate has two hard requirements: every declared command exits
   successfully and a separate read-only Codex gate turn returns `passed=true`.
   The gate retains the existing score, rubric, threshold, weight, provenance,
   manifest, artifact, and acceptance-catalog evidence model, but it has one
   Codex evaluator only. There is no cross-model reviewer or second acceptance
   scheduler, and there is no checkpoint-group layer.
3. One failed gate receives at most one automatic rework attempt. A second
   failure blocks the sub-issue and parent with a concrete next action.
4. Existing local Conductor Managed Run databases are archived and the new
   workflow database starts clean. Podium user, OAuth installation, selected
   project, Conductor, and binding data must be migrated in place and retained.
5. The current Web business experience is retained. Historical full-log fetch
   infrastructure that the Web does not call is removed; the current cached log
   tail remains available.

The user approved these assumptions before implementation. Revisit this spec
only if a stop condition or a customer-visible contract change is discovered.

## Canonical Product Flow

```text
Podium polls Linear
  -> records one delegation epoch and one dispatch
  -> Conductor leases the dispatch over HTTP
  -> Conductor starts/resumes one durable run
  -> Performer asks Codex for one ordered plan without changing files
  -> Conductor records a plan revision and its approval/evidence metadata
  -> Conductor validates the approved plan and creates Linear sub-issues
  -> Conductor executes the first unfinished sub-issue through Performer/Codex
  -> Conductor runs the sub-issue acceptance commands
  -> Performer runs one read-only Codex gate turn
  -> gate pass marks the sub-issue Done
  -> gate failure reworks once, then blocks visibly
  -> repeat sequentially
  -> all sub-issues Done marks the parent Done
```

Repeated Linear polls, Podium dispatch retries, Conductor restarts, and stale
Performer results must converge on the same run and must not duplicate a
sub-issue or repeat a completed task.

## Required Product Surfaces

### Linear

Keep unchanged:

- default and customer-owned application OAuth, PKCE/state, app actor and scope
  validation, refresh, reconnect, revoke, and cutover;
- selected projects, full cursor pagination, polling checkpoints, delegation
  epochs, dispatch deduplication, blockers, and project binding routing;
- Podium-owned `symphony:conductor/<Name>-<public-id>` project labels;
- parent issue, ordered work sub-issues, state projection, comments, gate
  evidence, acceptance-catalog links, plan-revision/approval comments,
  sanitized failures, and `[Human Action]` runtime-wait issues;
- explicit parent relationship checks through `parent { id identifier }`.

Remove Linear dependency relations, integration-conflict children, checkpoint
group projections, and arbitrary comment commands. Plan revisions, plan/work-
item approval, and gate/evidence issue trees remain part of the retained
workflow; a parent may require approval before a revision becomes active.

### Podium Web

Keep the current routes, authentication, onboarding, Linear application choice,
project and repository selection, runtime enrollment/binding, smoke action,
runtime/operator pages, managed-runs page, error states, translations, design
tokens, cookies, redirects, and secret boundary.

The managed-runs response keeps the fields the current Web reads:

- conductor, project, binding, runtime group, policy revision, and profiles;
- run id, issue identifier, state, active work item, latest reason,
  `plan_version`, `plan_revision`, approval status, thread id, and work items;
- work-item id, title, objective, likely files, state, `gate_status`, gate
  score/rubric summary, threshold, provenance, and artifact references;
- sanitized risk, architecture-decision, open-question, acceptance-catalog,
  and gate-evidence summaries.

`policy_revision` and `plan_version` are durable run/plan-revision values.
Runtime profile registries may be removed, but the version history and its
approval/evidence remain available to Linear and the operator report.

### Error Visibility

Every blocking or terminal failure stores and exposes:

```text
error_code
sanitized_reason
action_required
retryable
next_action
```

The same failure must be visible in durable state, correlated single-line logs,
the relevant Linear parent/sub-issue, and the Podium managed-runs response.
Secrets, tokens, cookies, passwords, client secrets, raw Codex credentials, and
authorization headers never enter browser responses, Linear, or logs.

## Runtime Transport: HTTP Polling Only

There is no socket endpoint, client, setting, install response field,
presence state, compatibility response, or dependency.

Keep these authenticated HTTP operations:

```text
POST /api/v1/runtime/dispatches/lease
POST /api/v1/runtime/dispatches/ack
POST /api/v1/runtime/commands/lease
POST /api/v1/runtime/commands/ack
POST /api/v1/runtime/report
```

The runtime report carries the current sanitized log tail and the small local
Codex configuration summary needed by Podium views. There is no separate log
chunk/fetch channel or Podium-owned runtime-config endpoint/table.

Runtime commands use `queued | leased | completed | failed`, a five-minute
lease, and an integer fencing token. Lease selects the oldest queued or expired
command transactionally. Ack with a stale fence returns `409` and changes
nothing.

Commands are limited to the current Web-required control operations:

```text
project.configure
project.unconfigure
project.prepare_installation
project.activate_installation
smoke.check
```

`dispatch.available`, `human.answered`, and `log.fetch` are removed. The Web
reads the cached log tail already sent in runtime reports. Configure/cutover
command delivery is acknowledged immediately; the next runtime report remains
authoritative for observed binding state.

One Conductor polling loop performs, in order:

1. send the runtime report when due;
2. lease, handle, and ack at most one control command;
3. lease, handle, and ack at most one dispatch;
4. advance the local workflow once;
5. wait with bounded backoff and jitter.

Any authenticated lease, ack, or report refreshes the Conductor presence TTL.

## Minimal Workflow Contract

### Plan

```json
{
  "summary": "string",
  "tasks": [
    {
      "id": "task-1",
      "title": "string",
      "objective": "string",
      "acceptance_criteria": ["string"],
      "verification_commands": ["string"],
      "files_likely_touched": ["path"]
    }
  ]
}
```

Validation requires 1-10 tasks, unique ids, non-empty titles/objectives,
1-5 acceptance criteria, at least one verification command, and non-empty file
scope. Array order is execution order. Task contracts have no dependency,
parallelization, or checkpoint fields. The enclosing plan revision may carry
approval status, risks, architecture decisions, open questions, an acceptance
catalog reference, and a manifest/artifact index.

### Plan revisions and acceptance evidence

Each run may have multiple immutable plan revisions. A revision records its
version, reason, approval status, plan payload, policy revision, risks,
architecture decisions, open questions, acceptance-catalog reference, and
manifest/artifact references. Only one revision is active; a superseded
revision remains readable for provenance.

Gate evidence records command results plus the single Codex gate's score,
rubric rows, threshold, weights, provenance, findings, and artifact references.
The evidence may be projected to dedicated Linear child issues, but it is still
one Conductor gate and not a second scheduler or cross-model review.

### Turn Context

```json
{
  "run_id": "string",
  "task_id": "string-or-empty-for-plan",
  "attempt_id": "string",
  "fencing_token": 1,
  "turn_kind": "plan|execute|gate"
}
```

`attempt_id` is the lease identity; do not retain separate lease, turn, and
session fence concepts. Performer validates and echoes the exact context.
Conductor rejects missing, stale, or mismatched results before any state change.

### Execute Result

```json
{
  "status": "ready_for_gate|blocked|failed",
  "summary": "string",
  "changed_files": ["path"],
  "acceptance_evidence": [
    {"criterion": "string", "evidence": "string"}
  ],
  "blocked_reason": "string-or-null"
}
```

### Gate Result

```json
{
  "passed": true,
  "score": 0,
  "threshold": 0,
  "rubric": [],
  "provenance": [],
  "artifacts": [],
  "summary": "string",
  "findings": ["string"]
}
```

Conductor supplies the diff, accepted criteria, and actual command outputs to
the read-only gate turn. A gate turn changing files fails closed.

## Minimal State Model

```text
run:     planning -> awaiting_approval -> executing -> blocked | failed | done
task:    todo -> in_progress -> in_review -> blocked | done
attempt: running -> waiting | succeeded | failed | stale
```

- `in_review` means acceptance gate execution.
- A runtime approval/tool-input wait changes the active attempt to `waiting`,
  blocks the run/task, records the wait, and creates one `[Human Action]` child.
  Completing that exact child resumes the same task/thread under a fresh fenced
  attempt.
- A transient process failure may retry once under a fresh attempt/fence.
- A gate failure returns the task to `in_progress` once with gate findings;
  the second failure leaves task/run `blocked`.
- A plan revision remains `draft` until its approval is recorded, then becomes
  the sole `active` revision. Revision approval is not a dependency graph or a
  checkpoint group.
- Parent Done requires every planned work sub-issue Done and a current parent
  summary. There is no separate `verified`, `ready`, or integration state.

## Persistence

Conductor uses one SQLite database with the workflow and retained evidence:

```text
settings
instance
runs
tasks
attempts
runtime_waits
plan_revisions
acceptance_catalog
gate_evidence
artifacts
```

An optional `smoke_results` table is allowed only if command ack cannot carry
all durable smoke evidence. There are no dependency, parallel, checkpoint-
group, branch-join, integration-queue, or generic runtime-action tables.
`plan_revisions`, `gate_evidence`, and `artifacts` are the retained compact
provenance model, not a second workflow engine.

Podium keeps PostgreSQL authority for users, sessions, Linear applications and
installations, selected projects, Conductors, bindings, polling observations,
checkpoints, delegation epochs, dispatches, commands, reports, and cached log
tails. Delete `runtime_groups`; keep `runtime_group_id` as a stable field on the
Conductor record so the Web response does not change.

## Target Source Shape

```text
performer_api/      <= 5 modules, 350-500 LOC
performer/          <= 6 modules, 900-1,100 LOC
conductor/          about 11 modules, LOC re-estimated for retained evidence
podium/             about 40-50 modules, 8,000-9,000 LOC
podium/web/src/     current business source retained
```

These are review budgets, not automated line-count gates.

## Testing Strategy

Delete the current Python and Web tests instead of migrating them. Rebuild only
behavior tests for this spec:

- at most 30 Python tests in seven files, no more than about 2,500 LOC;
- at most 15 Web tests in six files, no more than about 750 LOC;
- one real product-flow runner and one Linear fixture helper, no scenario
  registry, observer, auditor, appendix, cross-model reviewer, or E2E
  self-test suite. The retained acceptance catalog and gate evidence writer are
  product fixtures, not a second acceptance scheduler.

Budgets are not CI line-count gates. Tests must cover the canonical flow,
idempotency/recovery, stale fencing, Linear pagination/checkpoints/epochs,
sub-issue relationships, plan revision/approval, boolean score/rubric gates,
catalog/evidence/provenance, visible sanitized failures, HTTP command polling,
preserved Web flows, and browser secret boundaries.

## Commands

```bash
make install
make test
cd packages/podium/web && npm run test
cd packages/podium/web && npm run lint
cd packages/podium/web && npm run build
cd packages/podium/web && npm run design:lint
```

The rebuilt real flow is:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python tools/real_flow.py
```

## Never Rebuild

- socket transport or a second runtime transport;
- dependency DAGs, parallel scheduling, capacity policies, branches, branch
  joins, checkpoint groups, or integration queues;
- generic Engine/command/effect/repository abstractions or one-implementation
  Protocols/registries;
- cross-model reviewers, a second acceptance scheduler, or a second gate
  authority;
- backward-compatibility shims for removed WS, workflow, test, or tool surfaces;
- code-size, exact-module, tombstone, source-string, phrase, or documentation
  length tests.

## Success Criteria

1. A real delegated Linear parent produces ordered sub-issues.
2. Conductor executes one task at a time through fenced Performer/Codex turns.
3. A sub-issue reaches Done only when commands and the read-only Codex gate pass.
4. A failed gate stays non-Done with the same sanitized reason in SQLite, logs,
   Linear, and Podium.
5. The parent reaches Done only after every work sub-issue is Done.
6. Restart/replay creates no duplicate run, task, sub-issue, attempt, or dispatch.
7. No production code, package dependency, response, install command, setting,
   test, tool, or active document references the removed socket transport.
8. Existing Podium Web business flows and browser-visible behavior still work.
9. Linear OAuth, polling, project selection, dispatch, binding, labels, and
   proxy behavior still work.
10. Plan revisions, approval, acceptance-catalog links, score/rubric evidence,
    and artifact provenance remain visible without checkpoint groups or
    cross-model acceptance.
11. The old test/tool/document architecture is absent and the new small suite
    plus one real flow is green.
