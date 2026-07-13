# Spec: Minimal Polling Workflow

Status: approved for implementation as of 2026-07-12 and amended by accepted
ADR-0005 and ADR-0006 on 2026-07-13. This specification replaces the expanded
Managed Run design; real Linear/OAuth/Performer verification remains
environment-dependent.

## Objective

Symphony has one job: turn a delegated Linear parent issue into a sequence of
Linear sub-issues, let the selected Performer backend implement them, require an
acceptance gate for each sub-issue, and complete the parent only after every
gate passes.

Podium remains the customer-facing control plane and Web application. Podium
owns Linear OAuth, project selection, Conductor enrollment/binding, Linear
polling, dispatch, project labels, proxying, and operator views. Conductor owns
one bound repository, the sequential workflow, Performer processes, gates,
durable recovery, Linear sub-issue projection, and visible failures. Performer
runs one fenced backend turn from a JSON request file to a JSON result file and
owns all provider SDK integration.

The design is deliberately not a general workflow engine, DAG scheduler,
dynamic backend-plugin platform, multi-backend scheduler, cross-model
acceptance platform, or compatibility layer. Performer supports a closed set of
explicit backend implementations behind one interface; one managed run selects
one backend kind.

## Approved Baseline Decisions

1. Work sub-issues execute strictly in plan order. There is no dependency DAG,
   parallel group, capacity scheduler, per-task branch, or branch join.
2. One acceptance gate has three hard requirements: every declared command
   exits successfully, a separate read-only Performer gate turn returns
   `passed=true`, and its score meets the retained threshold. The gate retains
   the existing score, rubric, threshold, weight, provenance, manifest,
   artifact, and acceptance-catalog evidence model, but it has one selected
   backend evaluator only. There is no cross-model reviewer or second acceptance
   scheduler, and there is no checkpoint-group layer.
3. One failed gate receives at most one automatic rework attempt. A second
   failure blocks the sub-issue and parent with a concrete next action.
4. The cutover is hard: existing local Conductor/Managed Run state is discarded
   and the new workflow database starts clean. No old local or Podium runtime
   state is migrated; the deployment is initialized from the current `.env` and
   fresh control-plane state.
5. The current Web business experience is retained. Historical full-log fetch
   infrastructure that the Web does not call is removed; the current cached log
   tail remains available.

The user approved these assumptions before implementation. Revisit this spec
only if a stop condition or a customer-visible contract change is discovered.

## ADR-0006 Amendment: Performer Backend Boundary

The following accepted decisions override every older credential-slot,
Podium-managed provider document, TOML validator, per-attempt provider-home,
and Conductor-owned provider SDK statement in this specification:

- Conductor depends only on closed wire contracts in `performer_api` and
  launches the installed `performer` command. It never imports `performer`, a
  provider SDK, or provider-generated types.
- Performer owns an internal `PerformerBackend` Protocol/ABC and explicit
  closed registry. Codex is the first production implementation; another
  provider requires its own approved adapter design rather than Conductor
  changes.
- Provider SDK imports, authentication, account/config behavior, Check,
  provider handles, policy mapping, response validation, and sanitization live
  only in Performer backend implementation modules.
- One Conductor selects one fixed backend process context and one backend kind
  for its lifetime. Conductor owns only the allowlisted environment, generic
  subprocess lifecycle, one control/turn lane, durable workflow state, and
  generic readiness gating.
- Podium stores only Symphony runtime policy, Performer policy, and profile/
  binding ids and hashes. It stores no provider account, credential, config
  source, API host, path, login handle, or Check result.
- Secret-bearing control operations use Performer stdin/stdout or an equivalent
  pipe, never persisted request/result files. The closed control request
  contains only metadata; a bounded secret value follows as a separate
  length-delimited stdin frame and is passed only as backend `secret_input`.
  A device-login SDK handle remains inside a long-running Performer control
  process; Conductor holds only a generic subprocess handle.
- Login, logout, and supported config mutation invalidate readiness. Check is
  explicit, manual, performs a real structured backend turn, has no automatic
  rollback, and must be `ready` before a managed turn starts.
- Conductor persists one secret-free `performer_control_state` row locally.
  Podium obtains capabilities/account/config/Check projections only through a
  bounded, no-store live relay using provider-neutral operations.
- Production Performer control and turn processes reuse the Conductor's fixed
  allowlisted environment; they do not create per-attempt provider homes. The
  real-E2E runner alone stages one isolated per-batch provider context from an
  approved fixed seed.
- Model, provider, sandbox, approval mode, reasoning settings, timeouts, and
  retries are Symphony policy carried in `project.configure` and fenced turn
  request JSON, then mapped to SDK calls only inside the selected backend.
- Capability differences use a closed `PerformerCapabilities` contract.
  Operation names, durable state, routes, UI containers, and generic errors do
  not contain provider SDK vocabulary.

ADR-0004 remains authoritative only for separate mutable `runtime_profiles`,
`performer_profiles`, and `performer_bindings` without profile revision tables.

## Canonical Product Flow

```text
Podium polls Linear
  -> records one delegation epoch and one dispatch
  -> Conductor leases the dispatch over HTTP
  -> Conductor starts/resumes one durable run
  -> Performer asks the selected backend for one ordered plan without changing files
  -> Conductor records a plan revision and its approval/evidence metadata
  -> Conductor validates the approved plan and creates Linear sub-issues
  -> Conductor executes the first unfinished sub-issue through Performer
  -> Conductor runs the sub-issue acceptance commands
  -> Performer runs one read-only backend gate turn
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

Remove Conductor workflow dependency relations, integration-conflict children,
checkpoint-group projections, and arbitrary comment commands. Podium's active
Linear blocker check remains retained intake behavior. Plan revisions and
plan/work-item approval remain part of the retained workflow; Gate/evidence is
projected as concise metadata or comments on existing parent/task issues, not
as a dedicated child-issue tree.

### Podium Web

Keep the current routes, authentication, onboarding, Linear application choice,
project and repository selection, runtime enrollment/binding, smoke action,
runtime/operator pages, managed-runs page, error states, translations, design
tokens, cookies, redirects, and secret boundary.

The managed-runs response keeps the fields the current Web reads:

- conductor, project, binding, runtime group, policy revision, and profiles;
- run id, issue identifier, state, active work item, latest reason,
  `plan_version`, thread id, and work items;
- work-item id, title, objective, likely files, state, and `gate_status`.

Detailed approval, catalog, rubric, provenance, manifest, artifact, and
sanitized bounded command evidence remain durable Conductor data. The existing
managed-runs report may add only the explicit safe summary contract; it never
returns command text/output, findings, or artifact/manifest locations.

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
Secrets, tokens, cookies, passwords, client secrets, raw provider credentials, and
authorization headers never enter browser responses, Linear, or logs.

## Runtime Transport: HTTP Polling Only

There is no WebSocket endpoint, client, setting, install response field,
WebSocket presence state, compatibility response, or dependency. Conductor
keeps its local HTTP listener for the existing local API. HTTP runtime reports
continue to refresh the retained heartbeat/presence TTL used by Podium Web.

Keep these authenticated HTTP operations:

```text
POST /api/v1/runtime/dispatches/lease
POST /api/v1/runtime/dispatches/ack
POST /api/v1/runtime/commands/lease
POST /api/v1/runtime/commands/ack
POST /api/v1/runtime/report
```

The runtime report carries the current sanitized log tail and the current
Symphony profile ids, binding generation, and policy hashes. It carries no
provider account, config source, API host, credential, path, or Check state.
Podium owns reusable runtime profiles containing `execution_policy`, Performer
profiles containing `turn_policy`, and one Performer binding per project
binding. The selected policy documents and hashes travel through the existing
`project.configure` command; there is no credential upload and no separate log
chunk/fetch channel. Live Performer capability/account/config/Check operations
use the ephemeral no-store Conductor relay and are never runtime-report facts.

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

Gate evidence records command results plus the single selected-backend gate's
score, rubric rows, threshold, weights, Conductor-generated Performer attempt
provenance, findings, and artifact references. Conductor stores bounded, sanitized
command/output excerpts and findings locally,
then projects only a concise parent/task summary: plan version, catalog/rubric,
provenance, command counts, score/threshold, manifest/artifact counts, and a
failure code. It does not create a dedicated evidence child issue. It remains
one Conductor gate, not a second scheduler or cross-model review.

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
  "artifact_refs": [],
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
performer_control_state
```

An optional `smoke_results` table is allowed only if command ack cannot carry
all durable smoke evidence. There are no dependency, parallel, checkpoint-
group, branch-join, integration-queue, or generic runtime-action tables.
`plan_revisions`, `gate_evidence`, and `artifacts` are the retained compact
provenance model, not a second workflow engine.

`performer_control_state` is one local secret-free row containing backend kind,
capability version, binding/policy identity, current Check status, the last
Check outcome, timestamps, a closed generic error code, and a sanitized reason.
Conductor startup resets current readiness to `unchecked` while retaining the
previous sanitized outcome as evidence. A backend-kind, binding-generation, or
policy-hash mismatch also invalidates readiness.

Podium keeps PostgreSQL authority for users, sessions, Linear applications and
installations, selected projects, Conductors, project bindings, runtime
profiles with `execution_policy` and its hash, Performer profiles with
`turn_policy` and its hash, Performer bindings, polling observations,
checkpoints, delegation epochs, dispatches, commands, reports, and cached log
tails. Delete `runtime_groups`; derive `runtime_group_id` as a stable
presentation alias from the Conductor id so the Web response does not change.
Provider config text/hash, account, auth method, API host, Check state,
provider home/path, credential files, API keys, and access tokens are never
Podium facts.

## Source Shape Guardrails

Preserve the current package boundaries and role ownership. Do not turn old
module/line-count estimates into implementation work or delete current behavior
to satisfy a historical budget. New code must stay in the smallest role-owned
module that expresses one responsibility: shared policy/control contracts in
`performer_api`; backend interface, provider SDK control, and turn execution in
`performer`; generic subprocess/readiness/workflow ownership in `conductor`;
and authenticated relay/UI behavior in `podium`.

Provider SDK dependencies, imports, generated types, provider config/auth
parsers, and provider login handles may exist only in Performer backend
implementation modules. Conductor and Podium must not contain provider
controllers or branch on provider SDK response shapes.

## Testing Strategy

Preserve the current behavior-oriented Python and Web suites and replace only
tests whose asserted architecture is superseded by ADR-0005/ADR-0006. Do not delete
working coverage to meet a historical file/count budget. Keep one real
product-flow runner and one Linear fixture helper; do not add a scenario
registry, observer framework, auditor, appendix, cross-model reviewer, or
second E2E runner. The retained acceptance catalog and gate evidence writer are
product fixtures, not a second acceptance scheduler.

Tests must cover the canonical flow,
idempotency/recovery, stale fencing, Linear pagination/checkpoints/epochs,
sub-issue relationships, plan revision/approval, boolean score/rubric gates,
catalog/evidence/provenance, visible sanitized failures, HTTP command polling,
preserved Web flows, browser secret boundaries, Performer-owned provider
login/config, manual Check readiness, fixed-context Performer execution, the
internal backend contract/registry, and provider-SDK import guardrails.

Implementation verification uses phase-level batches:

```text
complete one coherent phase
  -> run that phase's focused tests
  -> run make test once and capture the complete failure set
  -> group all failures by root cause
  -> repair root-cause groups without one-test patch loops
  -> rerun focused tests and make test
```

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
- generic Engine/command/effect/repository abstractions, dynamic backend
  plugins, entry-point discovery, or a provider marketplace; the required
  Performer-owned backend Protocol/ABC and explicit closed registry are not
  prohibited by this rule;
- cross-model reviewers, a second acceptance scheduler, or a second gate
  authority;
- backward-compatibility shims for removed WS, workflow, test, or tool surfaces;
- code-size, exact-module, tombstone, source-string, phrase, or documentation
  length tests.

## Success Criteria

1. A real delegated Linear parent produces ordered sub-issues.
2. Conductor executes one task at a time through fenced Performer turns while
   importing only `performer_api` contracts.
3. A sub-issue reaches Done only when commands and the selected backend's
   read-only gate pass.
4. A failed gate stays non-Done with the same sanitized reason in SQLite, logs,
   Linear, and Podium.
5. The parent reaches Done only after every work sub-issue is Done.
6. Restart/replay creates no duplicate run, task, sub-issue, attempt, or dispatch.
7. No production code, package dependency, response, install command, setting,
   test, tool, or active document references the removed WebSocket runtime
   transport.
8. Existing Podium Web business flows and browser-visible behavior still work.
9. Linear OAuth, polling, project selection, dispatch, binding, labels, and
   proxy behavior still work.
10. Plan revisions, approval, acceptance-catalog links, score/rubric evidence,
    and artifact provenance remain visible without checkpoint groups or
    cross-model acceptance.
11. The obsolete test/tool/document architecture is absent and the retained
    behavior suite plus one real flow is green.
12. Podium can relay capability-supported login, session deletion, redacted
    config source, logical Base URL update, and manual Check without persisting
    provider-owned data or returning secrets.
13. A Conductor restart or provider login/config mutation leaves Check
    `unchecked`; only a successful manual real-turn Check permits the next
    plan, execute, or gate turn.
14. Production control and turns reuse one fixed Conductor-selected backend
    process context, while the single real-E2E batch uses one isolated staged
    test context and model `gpt-5.4` for the Codex implementation.
15. `performer_api` contains provider-neutral closed contracts, Performer owns
    the backend interface/registry and SDK adapters, and Conductor/Podium have
    no provider SDK dependency or provider-specific controller.
16. Secret-bearing controls use pipes and leave no durable control request,
    result, log, report, or browser-cache artifact.
