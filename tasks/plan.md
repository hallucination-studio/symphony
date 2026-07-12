# Implementation Plan: Minimal Polling Workflow Rebuild

Status: implementation approved and locally applied as of 2026-07-12. External
Linear/OAuth/Codex verification remains pending. This plan supersedes both the
stale capability-refactor plan and the later conservative contraction draft.
The source of truth for the target product is `tasks/spec.md`.

## Outcome

Hard-cut Symphony to one product flow:

```text
Linear parent
  -> ordered Linear sub-issues
  -> sequential Codex execution
  -> boolean acceptance gate per sub-issue
  -> parent Done
```

Podium continues to own Linear and the existing Web business. Runtime transport
is HTTP polling only. Conductor is rebuilt as a small sequential orchestrator,
not simplified around the edges of the current 71-module design. Existing tests,
tools, and expanded runtime docs are deleted and replaced from the new spec.

## Scope Ledger

### authorized

- Delete all existing Python and Web tests, then rebuild a small suite.
- Delete all existing tools and rebuild only one real flow plus one fixture
  helper.
- Delete the expanded runtime/acceptance documentation and rewrite concise docs.
- Remove the WebSocket runtime transport: its routes, settings, commands,
  dependencies, tests, docs, and compatibility behavior. The retained local
  Conductor HTTP listener is not part of that transport.
- Replace the current Conductor Managed Run implementation with the sequential
  parent/sub-issue/gate workflow plus the retained plan-revision, approval,
  rubric, catalog, manifest, and evidence semantics in `tasks/spec.md`.
- Hard-delete unneeded shared contracts, states, tables, abstractions, backends,
  branches, checkpoint groups, and compatibility surfaces.

### required consequences

- Preserve Podium Web routes, actions, visible behavior, auth, onboarding,
  runtime binding, smoke, logs, managed-runs, and secret boundaries.
- Preserve Linear OAuth, tokens, project selection, pagination, checkpoints,
  delegation epochs, dispatch dedupe, binding, labels, proxy, parent/sub-issue
  projection, and visible failures.
- Preserve one-shot Performer process isolation, request/result files, staged
  `CODEX_HOME`, fencing, retries, logs, and sanitized errors.
- Preserve plan revisions, approval state, risks, architecture decisions, open
  questions, acceptance catalogs, score/rubric/threshold/weight/provenance,
  manifests, artifacts, and gate/evidence Linear projections.
- Preserve customer-visible control-plane behavior in a fresh PostgreSQL
  schema; no existing database rows are migrated or read during the hard cut.
- Keep the four package import boundary and installed CLI entrypoints.

### out_of_scope

- Parallel execution, dependencies, capacity scheduling, branches, joins,
  checkpoint groups, integration queues, cross-model acceptance, a second
  acceptance scheduler, or multiple planning/execution backends.
- Visual redesign or removal of a Podium Web business flow.
- Direct Linear tokens in Conductor or the browser. Conductor continues through
  Podium runtime authentication and the Podium Linear proxy.
- Backward-compatible WS or old Managed Run APIs/state machines.

### assumptions_requiring_approval

- The five assumptions in `tasks/spec.md`, especially strict sequential work,
  the boolean gate definition, one automatic rework, and hard deletion of old
  local/runtime state without migration.

All five assumptions were approved by the user before implementation. Archive
and real-flow verification are operational follow-ups, not design gates.

## Baseline And Target

| Area | Current | Target | Expected change |
|---|---:|---:|---:|
| `performer-api` | 9 modules / 953 LOC | <= 5 / 350-500 | remove 45%-63% |
| `performer` | 11 / 1,707 | <= 6 / 900-1,100 | remove 36%-47% |
| `conductor` | 71 / 10,323 | about 11 / re-estimate | retained evidence scope must be budgeted |
| `podium` Python | 66 / 10,072 | about 40-50 / 8,000-9,000 | remove 11%-21% |
| Python production total | 23,055 LOC | about 12,250-14,200 | remove 38%-47% |
| Python tests | 67 files / 25,171 LOC / 691 tests | 7 / <=2,500 / about 30 | remove about 90% |
| Web tests | 20 files / 2,004 LOC / 70 tests | 6 / <=750 / <=15 | remove about 63% |
| Tools | 68 files / 11,824 LOC | 2 / <=850 | remove about 93% |
| Tests/tools/runtime docs | about 43,034 LOC | about 4,800 | remove about 89% |

These are planning budgets, not automated size gates. Retaining revisions,
catalogs, verifier scoring, manifests, and evidence makes the Conductor budget a
review item. Product behavior decides what remains.

## Target Module Map

### `performer-api`: rewrite

Replace the current nine-module Managed Run contract with:

```text
performer_api/
  __init__.py
  workflow.py     # Plan, Task, ExecuteResult, GateResult
  turns.py        # TurnContext, TurnRequest, TurnResult, RuntimeWait
  runtime.py      # one Codex runtime configuration
  validation.py   # small plan/context validators
```

Delete capacity, per-role profiles, parallelization, slice types, checkpoint
groups, dependency validation, and their compatibility exports. Retain the
durable plan-revision/policy-version fields, approval state, risks,
architecture decisions, open questions, rubric and provenance contracts.

The only shared turn kinds are `plan`, `execute`, and `gate`. One `attempt_id`
plus `fencing_token` replaces separate lease/turn/fence identities.

### `performer`: rewrite

Target:

```text
performer/
  __init__.py
  cli.py          # request file -> one turn -> result file
  config.py       # staged Codex configuration
  codex.py        # direct pinned SDK client
  backend.py      # plan/execute/gate prompts and parsing
  schemas.py      # the three output schemas
```

Delete the current compatibility adapter, maybe-await layer, continuation
surface, generic default schema, ignored title/worker-host options, synthetic
wait injection, role backend registry, and split helper/runtime/event modules.

Keep direct SDK init/turn/resume/stream/close, overload and timeout handling,
structured result retry, runtime wait extraction, event capture, and sanitized
errors.

### `conductor`: rebuild, not refactor

Target approximately 11 modules:

```text
conductor/
  __init__.py
  cli.py          # installed entrypoint
  api.py          # existing local API surface
  models.py       # settings, instance, run, task, attempt, wait
  store.py        # one SQLite database
  service.py      # composition root and one background tick
  podium.py       # HTTP report/command/dispatch/config/smoke
  linear.py       # proxy, sub-issues, revisions, gates, comments, runtime wait
  workflow.py     # the only sequential state machine
  gate.py         # commands, rubric/verifier, score, evidence, and gate input
  runtime.py      # Performer process, CODEX_HOME, logs, fencing
```

#### Necessary logic to retain in the fresh cutover

- CLI/local API and instance/repository setup.
- HTTP dispatch lease/ack and reporting.
- concrete Linear GraphQL/proxy operations for parent, child, comment, state,
  project label read, and runtime-wait child.
- plan turn, ordered task creation, plan approval/revision, sequential
  execution, one rework, rubric-backed gate, evidence projection, completion,
  and current Web report.
- one SQLite store with `settings`, `instance`, `runs`, `tasks`, `attempts`,
  `runtime_waits`, `plan_revisions`, `acceptance_catalog`, `gate_evidence`, and
  `artifacts`.
- Performer launch/result collection, staged runtime home, stdout/stderr logs,
  stale fence rejection, bounded retry, and failure parity.

#### Delete after the fresh cutover

Delete the current modules for:

- relation/dependency ingestion and DAG readiness;
- attempts payload overlays and duplicate plan/policy version machinery outside
  the single revision owner;
- branch join, execution handoff, checkpoint results, integration state, and
  workspace-event abstractions;
- coordinator helper/checkpoint/runtime-wait mixins that duplicate the retained
  workflow owners;
- driver plan/work-item/attempt collection/helper/service fragments;
- generic human-action and projection helper stacks;
- Managed Run store/view/artifact/row mixins and verifier scoring wrappers that
  duplicate the retained store/evidence owners;
- Podium sync background/failure/Linear/project-label/WS mixins;
- runtime backend registry, env-command/lifecycle/log/process/type fragments;
- service view/type/runtime-view helpers, smoke outbox store, store row helper,
  generic time module, and standalone Podium client.

The necessary pieces from those files move once into the target owners; the
old source files then disappear. Do not leave facade wrappers or compatibility
imports.

#### Minimal state

```text
run:     planning -> awaiting_approval -> executing -> blocked | failed | done
task:    todo -> in_progress -> in_review -> blocked | done
attempt: running -> waiting | succeeded | failed | stale
```

`in_review` is the acceptance gate. Podium Web already understands these state
words. `plan_version` and `policy_revision` are durable revision values, not
presentation-only constants; only one plan revision is active at a time.

### `podium`: preserve business, remove runtime duplication

Keep auth, sessions, onboarding, all Linear application/installation/token/
project/cutover modules, full polling reconciliation, dispatch routing,
Conductor enrollment/binding/replacement/labels, proxy, health, BFF routes,
PostgreSQL transaction/CAS/advisory-lock behavior, and browser sanitization.

#### Replace WS with HTTP commands

Keep existing dispatch lease/ack. Add command lease/ack to
`podium_routes_runtime_ops.py` and its PostgreSQL owner:

```text
POST /api/v1/runtime/commands/lease
POST /api/v1/runtime/commands/ack
```

Commands have `queued|leased|completed|failed`, a five-minute lease, and an
integer fence. Move smoke result validation into command ack. Runtime reports
confirm configure/unconfigure/installation cutover state.

#### Delete

- `podium_routes_runtime_ws.py` and WS registration.
- `podium_routes_runtime_smoke.py`; smoke result uses command ack.
- `podium_routes_runtime_helpers.py` after inlining the few remaining helpers.
- socket attach/detach/presence, `dispatch.available`, socket URL generation,
  WS install-script parsing, and WS response compatibility.
- `runtime_groups` table/service model and old runtime rows; the fresh schema
  creates only the fields needed by current Web responses.
- Podium-owned Managed Run role profiles/capacity/runtime-config table and its
  `performer_api` dependency. Minimal Codex config is local to Conductor; Web
  still receives the current sanitized policy/plan revision and retained
  evidence summaries; profile registries are not reintroduced.
- duplicate runtime/enrollment/shared ownership helpers, non-CAS smoke writer,
  historical full-log command/result path, and dead imports.
- `uvicorn[standard]`; use `uvicorn` without the WS stack.

#### Merge

- pure route registrars into the app composition root;
- runtime enrollment/ops registration into one runtime route owner;
- smoke protocol into smoke checks;
- statement-only SQL fragments into one ordered schema owner;
- reconciliation supervisor into reconciliation;
- repeated constants, row mapping, repository visibility, label error logging,
  and env flag parsing into existing concrete owners.

Do not rewrite topology transactions, OAuth lifecycle, polling reconciliation,
or Linear error classification merely to reduce file count.

### Podium Web: keep source behavior, reset tests

Keep the source routes/pages/components/API/i18n/styles/design system and
committed static build. Update types or comments only where the backend's
internal policy/profile implementation disappears; rendered behavior and
business requests remain the same.

Delete all current Web tests and test helpers. Rebuild only:

```text
src/test/setup.ts
src/test/render.tsx
src/App.test.tsx
src/api/client.test.ts
src/pages/SetupPage.test.tsx
src/pages/ProductPages.test.tsx
```

### Tests, tools, and docs: reset

#### Delete completely

- `tests/` (then recreate the directory with the seven new files below).
- every current Web `*.test.ts(x)` and `src/test/` helper.
- current `tools/`, including the 41-file real E2E harness, observers,
  auditors, duplicate evidence runners, code-size gate, and architecture
  inventory. Rebuild the retained acceptance catalog and evidence writer.
- duplicate decision/runtime guides and legacy workflow files; keep the
  product source-of-truth docs plus `docs/architecture.md`, `docs/workflow.md`,
  and `docs/real-flow.md`.
- duplicate agent guidance after moving the small set of current rules into one
  `AGENTS.md`. Keep `packages/podium/web/DESIGN.md`.

#### Rebuild Python tests

```text
tests/conftest.py
tests/test_minimal_performer_api.py
tests/test_minimal_performer_turn.py
tests/test_runtime_contract.py
tests/test_conductor_gate.py
tests/test_conductor_workflow.py
tests/test_conductor_recovery.py
tests/test_conductor_runtime.py
tests/test_workflow_driver.py
tests/test_podium_runtime_polling.py
tests/test_package_boundaries.py
```

These approximately 30 tests own only the new product facts: contract/fence,
ordered sub-issues, revision/approval, score/rubric gates, catalog/evidence/
provenance, parent completion, recovery/idempotency, failure visibility,
OAuth/pagination/checkpoint/epoch/dispatch, HTTP runtime polling, Web/BFF
security, and one process-boundary product flow.

#### Rebuild tools

```text
tools/real_flow.py       # one real browser/Linear/Codex flow, <=650 LOC
tools/linear_fixture.py  # create/read/clean test issues, <=200 LOC
```

No tool self-test suite, cross-model reviewer, or second acceptance system.

#### Rebuild docs

```text
README.md
AGENTS.md
docs/architecture.md
docs/workflow.md
docs/real-flow.md
```

## Implementation Phases

### Phase 0: Approve The Hard Break

1. Approve `tasks/spec.md`, including sequential execution, boolean gate, one
   rework, and hard deletion of old local/runtime state without migration.
2. Record a sanitized snapshot of current Web routes/API responses and Podium
   customer-data tables that must survive.
3. Record the current package/build commands. Do not use the old tests as the
   target contract.

Gate: no unresolved product assumption and an explicit Podium data-retention
list.

### Phase 1: Remove The Second Product

1. Delete all current Python/Web tests.
2. Delete all current tools.
3. Delete expanded decisions/product/real-run docs and legacy workflow files.
4. Remove code-size, architecture inventory, and the obsolete acceptance test
   harness; rebuild the retained acceptance catalog and evidence references.
5. Create the empty new test/tool/doc structure and update `make test` to target
   only the rebuilt suite.

Gate: production still builds/imports; no claim of behavioral completion yet.
The next phase starts by writing new RED contract tests.

### Phase 2: Replace Shared Contracts And Performer

1. Add RED tests for the minimal Plan, TurnContext, ExecuteResult, GateResult,
   invalid context, and stale fence.
2. Replace `performer-api` with the five target modules; delete old exports.
3. Add RED process tests for plan/execute/gate request-result files.
4. Rebuild the direct pinned-SDK client and backend.
5. Delete old Performer helper/adapter/runtime/schema files and probe-only code.
6. Prove real staged SDK init, plan, execute, gate, resume, wait, timeout, close,
   and secret isolation.

Gate: `test_performer_turn.py` green and one real isolated turn succeeds.

### Phase 3: Rebuild Conductor Core

1. Add RED store tests for the workflow and retained revision/catalog/evidence
   tables, restart, idempotent run/task creation, and stale fencing.
2. Build the new `models.py` and single `store.py`; start the fresh database
   without reading old local run state.
3. Add RED workflow tests for plan revision/approval -> ordered Linear
   sub-issues -> execute -> rubric-backed gate/evidence -> child Done -> parent
   Done.
4. Build the sequential `workflow.py`, `linear.py`, `gate.py`, and `runtime.py`.
5. Add one-rework, second-failure block, runtime wait, process retry, restart,
   and durable/log/Linear/API failure parity.
6. Rewrite service/api composition to one tick and current report shape.
7. Switch the entrypoint to the new composition root.
8. Remove the `Checkpoint` contract, checkpoint coordinator/result table,
   checkpoint workspace and branch-join helpers; retain and consolidate the
   revision/approval/catalog/rubric/manifest/artifact/verifier semantics.
9. Delete every old Conductor module not in the target tree; verify no import or
   compatibility residue.

Gate: workflow/recovery/product-flow tests green; target module and LOC budgets
audited manually; no branch/DAG/checkpoint-group/cross-model scheduler code
remains, while revision/manifest/evidence behavior is covered.

### Phase 4: Remove WS And Contract Podium Runtime

1. Add RED PostgreSQL/API tests for command lease/ack, expiry, fence, report
   confirmation, and dispatch polling.
2. Implement command lease/ack and change the Conductor tick to HTTP only.
3. Move smoke result to command ack and retain cached Web log tails.
4. Delete Podium/Conductor WS routes/tasks/settings/install fields/dependencies,
   dispatch wake queue, and historical log-fetch command.
5. Remove `runtime_groups` and Podium runtime policy/config ownership from the
   fresh PostgreSQL schema; do not migrate old runtime rows.
6. Merge the audited thin route/store/supervisor/helper modules.
7. Run OAuth, polling pagination/checkpoint/epoch, dispatch, binding, label,
   proxy, cutover, health, and secret-boundary tests.

Gate: repository-wide WebSocket/runtime-transport search finds no active
production, dependency, response, setting, test, tool, or doc reference; the
retained local Conductor HTTP listener and Web business APIs retain their
contract.

### Phase 5: Preserve Web Behavior With New Tests

1. Read `packages/podium/web/DESIGN.md`.
2. Rebuild the six-file Web test suite around auth/routes, full onboarding,
   runtime actions, managed runs, API error mapping, and secret absence.
3. Make only backend-contract adaptations required by the new internal model.
4. Run unit tests, lint, type/build, design lint, and real-browser desktop/mobile
   DOM, navigation, network, console, and screenshot checks.
5. Commit the rebuilt static assets.

Gate: the current user journeys and visible states work without WS knowledge.

### Phase 6: One Real Flow And Final Deletion

1. Build `linear_fixture.py` and `real_flow.py` only.
2. Run one clean real flow: browser OAuth/project/binding -> Linear delegation
   and full pagination -> HTTP dispatch -> plan -> sub-issues -> execute -> gate
   -> parent Done.
3. Archive one `report.json` plus product-owned logs, SQLite/PostgreSQL facts,
   request/result files, Linear tree, repository diff, and cleanup result.
4. Fail immediately on a known error and prove the sanitized reason appears in
   durable state, logs, Linear, and Podium.
5. Delete every remaining orphan module, schema/table, export, test helper,
   fixture, obsolete generated harness, old doc, and compatibility reference;
   keep the rebuilt acceptance catalog and evidence artifacts.
6. Record final files/LOC/tests/runtime against the target budgets.

Gate: new Python/Web suites, PostgreSQL contracts, build/lint, and the single
real flow are green. No cross-model review is required; product acceptance is
the single retained Conductor gate.

## Dependency Order

```text
approve spec/data hard break
  -> delete old tests/tools/docs
  -> minimal shared contracts
  -> Performer
  -> Conductor store/workflow/gate/runtime
  -> Podium HTTP command polling and WS deletion
  -> Web contract adaptation and rebuilt tests
  -> one real flow
  -> final orphan/schema/doc deletion
```

## Stop Conditions

- A proposed deletion breaks a current Podium Web user action or browser secret
  boundary not explicitly changed by the spec.
- A change loses Linear OAuth/project/polling/checkpoint/epoch/dispatch/binding/
  label/proxy behavior.
- A sub-issue can become Done without the gate, or a parent can become Done with
  a non-Done work child.
- A stale result, restart, or repeated poll can duplicate work or mutate current
  state.
- A failure exists only in stdout/local files and not in durable state, logs,
  Linear, and Podium.
- A fresh cutover accidentally reads or exposes old runtime state.
- New abstractions recreate a general scheduler, acceptance framework, or
  compatibility layer.

Any stop condition pauses the slice; it does not justify restoring the old
expanded architecture wholesale.
