# Implementation Plan: Capability Refactor And Release Acceptance

Status: stale as of 2026-07-11. Retained for historical reference; do not use
this document as an active implementation plan.

## Objective

Implement the `main` snapshot of ADR-0002 after reconciling its intake language
with `main`'s polling-only product contract. The migration is deletion-first,
preserves the four runtime package boundaries, moves state decisions behind one
Conductor command facade, and completes the clean-architecture cutover before
any further product-function pruning. After that cutover, the retained product
scope is frozen explicitly, confirmed duplicate or low-value capabilities are
retired capability by capability, and only then is the real acceptance system
resumed against the smaller product surface.

The implementation proceeds in behaviorally complete slices. Every behavior
slice uses RED/GREEN tests, then a separate behavior-preserving
`code-simplification` review before its integration gate. A legacy source file
is removed only after its callers and exclusive tests are identified and the
replacement proof, when one is required, is green.

## Baseline

- Branch: `main`; audited HEAD: `dfce9fd`.
- Design source: `docs/decisions/0002-capability-modules-and-release-acceptance.md`
  as merged at `92502ed`. It still contains webhook/AgentSession assumptions
  that conflict with `main`'s polling-only `AGENT.md`, `AGENTS.md`, product docs,
  and contract tests. Conductor also retains a direct-dispatch compatibility
  path despite that product contract; `P0.0` fixes the design and `C0.3` removes
  the implementation exception.
- Production Python baseline: 27,124 lines.
- Pytest baseline: 761 nodes in 74 files. A fresh `make test` run passed 759,
  failed 1, and skipped 1 in 38.26 seconds; the only failure is
  `test_linear_removed_paths_are_absent_from_documentation` finding the stale
  ADR webhook language. This is a known red baseline, not an accepted gate.
- `P0.0/G0` resolution: after aligning every intake contract on polling-only
  semantics and separating dispatch-epoch identity from Managed Run identity,
  a fresh `make test` passed 760 and skipped 1 in 41.17 seconds.
- Real-run tooling baseline: 51 `tools/real_*.py` files and 8,246 lines.
- Current highest-risk defects: non-atomic duplicate dispatch acceptance and
  reopening, blocked work-item approval still launching Performer, process
  launch before durable attempt reservation, fake capacity, stale results
  failing current work, projection-owned completion, mutable dependency
  ingestion, and no final repository delivery record. Plan-level approval
  already blocks launch and accepted plan versions are already append-only;
  those working properties are migration inputs, not work to rebuild.
- Performer reachability audit: nine functional modules are in the explicit CLI
  closure, the required package `__init__.py` is loaded implicitly, and 16
  deletable modules/2,219 lines have no in-repository production consumer.
- Podium composition audit: the installed CLI requires PostgreSQL and builds
  `create_app(PgStore, config)`; six shadow service/model modules total 559
  lines and `JsonStoreLegacyMixin` adds 78. The current pytest suite makes zero
  real `PgStore.connect()` calls, and the real multiworker probe cannot import.
- Continuation audit at `dfce9fd` plus the current worktree: production Python
  is 23,055 lines (down 4,069/15.0% from baseline), but Conductor is effectively
  flat at 10,323 lines and still has about 44 direct `update_run_state()` and 19
  direct `update_work_item_state()` call sites. Phase 1 achieved real deletion;
  it did not yet establish one state-transition owner or a stable application
  boundary.
- Fresh verification is not a completed `G1`: `make test` reports 692 passed,
  36 skipped, and 2 failed. The non-E2E hard failure is the 377-line
  `tools/runtime_claims_audit.py` exceeding the 350-line gate. The second
  failure is in the deliberately paused E2E evidence path and remains a named
  known-red until product scope is frozen. PostgreSQL contracts also require a
  fresh non-skipped run before `G1` can close.

## Non-Negotiable Architecture

1. `performer_api` imports no runtime role; runtime roles never import each
   other.
2. Delegated-issue intake is polling-only: full baseline/incremental cursor
   pagination, transactional checkpoints, delegation epochs, and idempotent
   dispatch. Do not add webhook or AgentSession compatibility paths.
3. Codex proposes plans and implementation. Conductor owns deterministic
   durability, readiness, capacity, fencing, verification, waits, delivery,
   and terminal convergence.
4. Podium owns `DispatchLeaseRef`; Conductor owns `TurnLease`. Their ids,
   fences, heartbeats, expiry, and error codes never alias.
5. The accepted plan is immutable. Linear relations append a versioned
   `DependencyOverlay`; effective readiness is plan dependencies union the
   active overlay.
6. Linear operator input emits typed engine commands. Linear projection is
   read-only and cannot transition state.
7. `done` requires reconciled `DeliveryAttempt -> Git ref -> DeliveryRecord`.
8. One invariant has one cheapest trustworthy owner test. Higher-level tests
   must name a distinct wiring or boundary fact.
9. Core and major changes cannot be downgraded and require the canonical real
   customer journey and the Linear issue/comment experience reviewer.
10. `G2` is a hard boundary: no capability is removed, merged, or behaviorally
    narrowed before the clean-architecture cutover passes. Until then, every
    cataloged behavior is retained. Changing that order requires an explicit
    product-owner amendment to this plan; an implementation agent cannot infer
    an exemption from missing tests, low usage, or recently deleted callers.
11. Define a `Protocol` only for an external/volatile boundary, a boundary with
    multiple implementations, or a consumer-owned seam needed for isolated
    verification. A one-implementation internal helper does not earn an
    interface merely to satisfy a layering diagram.
12. Each business concept has one canonical owner model. Wire DTOs, database
    rows, API read models, and Linear projections are explicit translations at
    boundaries; the same mutable object is not threaded through every layer.
13. Through `G2`, refactor and behavior changes are separate slices and commits.
    Each GREEN migration receives an independent behavior-preserving
    `code-simplification` review before the next dependent slice starts.
14. No inferred scope expansion. Every new behavior, workflow branch, public or
    durable fact, configuration, integration, compatibility promise, and
    acceptance scenario must trace to an explicit request, accepted product
    contract, preserved behavior, or named in-scope defect/invariant. Ambiguity
    defaults to the smallest behavior-preserving change, not a helpful guess.

## Dependency Graph

```text
P0/X0/D1/D2/D3
       |
       v
      G1 deletion/reachability checkpoint
       +-----------------------------+
       |                             |
       v                             v
 C0 contract + engine facade   T1 local feedback DAG
       |
       +------------------+
       |                  |
       v                  v
 C0 repository/effect   P1 Podium ports
       +------------------+
                          |
                          v
             C0.3 dispatch + C1 planning/dependency
                          |
       +------------------+------------------+
       v                              v
 C2 attempt/lease/process      C3 waits/operator/projection separation
       +------------------------------+
                      |
                      v
        C4 verification/delivery convergence
                      |
                      v
       C5 composition cutover + bypass deletion
                      |
                      v
            G2 clean-architecture gate
                      |
                      v
        F0 capability inventory + scope freeze
                      |
          +-----------+-----------+
          v           v           v
 F1 Conductor     F1 Podium    F1 Performer/Web
          +-----------+-----------+
                      |
                      v
      F2 duplicate concept/test convergence
                      |
                      v
             GF lean-product gate
                      |
       +--------------+---------------+
       v              v               v
 H1 finalization   H2 runner       H3 Linear reviewer
       +--------------+---------------+
                      |
                      v
         G3 canonical customer journey
                      |
          G4 migration parity -> G5 retirement
```

## Workstreams And Exclusive Ownership

| Workstream | Exclusive production ownership | Test/tool ownership |
|---|---|---|
| `D1` Performer deletion | Confirmed unreachable files under `packages/performer/src/performer/` | Their exclusive Performer tests; no Conductor/Podium files |
| `D2` Podium shadows | `server.py`, synchronous services/models, `json_store_legacy.py`, then assigned JSON capability adapters | Production-app replacements for their tests |
| `D3` Shared contracts | `packages/performer-api/src/performer_api/` and import/reachability rules | Shared-contract and architecture tests only |
| `C0` Conductor foundation | engine/effects/repository contracts plus assigned store schema and dispatch acceptance | Engine/repository/dispatch contract tests |
| `C1` Planning | planning reducer, plan validation, dependency overlay | planning/dependency tests |
| `C2` Attempts | attempt reducer, turn lease, process/result adapter | attempt/process/fencing tests |
| `C3` Operator interaction | wait reducer, `operator_events.py`, and exclusive ownership of projection during separation | wait/operator/projection tests |
| `C4` Delivery | verification/delivery reducer, Git delivery adapter, then explicit handoff of projection for terminal cutover | verifier/delivery/reconciliation tests |
| `C5` Cutover | composition roots and deletion of direct coordinator/store/projector mutation paths | architecture bypass and change-radius contracts |
| `P1` Podium clean boundary | consumer-owned capability ports, atomic state/command operations, and composition | capability contract, PostgreSQL transaction, and no-`Any` boundary tests |
| `T1` Feedback accelerator | local test-domain commands, result envelope, and collect-all aggregator only; no real E2E behavior | test-runner contracts and aggregate reports |
| `F0` Scope decision | business capability catalog and approved keep/merge/remove/defer manifest | catalog completeness and decision-schema tests |
| `F1` Capability retirement | one role-owned retained/merged/removed capability slice at a time | exclusive consumer, migration, and tombstone tests |
| `F2` Concept convergence | duplicate role-local models, parsers, flags, read models, and test owners | duplicate-owner and zero-reference reports |
| `P*` Podium capabilities | one auth/installation/topology/intake/dispatch capability at a time | matching Podium contract/integration tests |
| `W` Performer retained path | reachable CLI/turn/Codex modules only | retained Performer CLI/backend tests |
| `H*` Acceptance | `tools/symphony_acceptance/`, CI/test commands, evidence schemas | catalog/oracle/execution tests |

No two active work items may edit the same production or migration-source
file. Cross-role wire changes land before consumers. A workstream that finds a
missing shared contract pauses only that dependent slice.

## Parallel Workflow Rules

- At every dependency frontier, schedule every ready slice whose declared file
  ownership and external resources do not overlap; do not serialize independent
  work for convenience.
- After `G0`, `X0`, `D1`, `D2`, and `D3` may run concurrently. Each deletion
  group remains its own atomic RED/GREEN/simplification commit.
- After `G1`, `T1` may run in parallel with the architecture stream because it
  owns only local test commands, envelopes, and aggregation. `T1` must not alter
  real E2E semantics while those tests are paused.
- `C0` establishes the shared command/repository/effect contracts. After its
  contract-first slice, the Conductor repository implementation and Podium
  capability ports may proceed in parallel under exclusive file ownership.
- `C1` follows the committed C0 contract. After `C1`, `C2` and `C3` run in
  parallel. `C4` starts only after both finish and receives `projection.py`
  through an explicit ownership handoff. `C5` then removes every bypass; file
  movement alone never satisfies the cutover.
- Within `D2`, `D2.1 -> D2.2`; `D2.3` runs in parallel with `D2.1`;
  `D2.3 -> D2.4` and `D2.3 -> D2.5`; `D2.6` waits for `D2.2` through `D2.5`
  and a zero-remaining-JSON-consumer proof.
- After `G2`, role-local capability inventories may run in parallel, but the
  keep/merge/remove/defer manifest is one joined, human-approved scope freeze.
  Shared wire or schema changes land before role-local consumers. After that,
  independent `F1` retirement slices run concurrently when their production,
  migration, test, and external-resource ownership do not overlap.
- `H2`, `H3`, and the real-run portion of `H1` remain deferred until `GF` and an
  explicit confirmation of the reduced product scope. Paused E2E findings stay
  visible as known-red evidence; they are neither fixed opportunistically nor
  counted as passes.
- A workflow failure never cancels independent siblings. The join gate reports
  every root cause and only blocks descendants with a named failed dependency.

## Phase 0: Executable Foundation

### P0.0 Reconcile ADR intake with `main`

`main` is polling-only, while the merged ADR still describes signed webhook and
AgentSession intake. Correct the ADR and its business/acceptance tables to use
fully paginated baseline/incremental polling, transactional page checkpoints,
delegation epochs, and polling recovery/deduplication. Do not change production
behavior in this slice.

Acceptance criteria:

- `AGENT.md`, `AGENTS.md`, product docs, ADR, and executable doc tests agree on
  one polling-only intake path.
- No acceptance scenario, real boundary, evidence requirement, or change-impact
  rule requires webhook/AgentSession behavior.
- The current known-red docs test becomes green without weakening the
  polling-only assertions.

Verification:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_product_docs_pipeline.py -q
make test
```

### P0.1 Record plan, ownership, and baseline

Acceptance criteria:

- `tasks/plan.md` and `tasks/todo.md` contain dependencies, exclusive file
  scopes, RED/GREEN commands, checkpoints, and simplification gates.
- Current test/reachability evidence is recorded without changing production
  behavior.

Verification:

```bash
git diff --check
.venv/bin/python tools/code_size_gate.py --check
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest --collect-only -q
```

### X0.1 Add business/scenario/journey catalog contracts

Files: `tools/symphony_acceptance/models.py`, `catalog.py`, package entrypoint,
and focused catalog tests.

Acceptance criteria:

- Every polling-only current-product business id has actor, job, start state,
  outcome, visible artifacts, and acceptance mapping.
- Every executable scenario has one `proves`, minimum level, real boundaries,
  authority/operator oracles, evidence, cleanup, and trigger tags.
- Catalog validation rejects missing mappings, duplicate ids, cycles, and a
  canonical journey without repository delivery evidence.

RED/GREEN:

```bash
PYTHONPATH=tools .venv/bin/python -m pytest tests/test_acceptance_catalog.py -q
```

### X0.2 Add change-impact contract

Files: `tools/symphony_acceptance/impact.py`, its schema/model, and focused
tests.

Acceptance criteria:

- Classification precedence is `core > major > localized` and unknown
  production paths block selection.
- Core/major cannot be downgraded and always select the canonical journey.
- An operator can promote one exact localized `ChangeImpactDecision` to
  `canonical_journey_required=true`; that immutable decision then forces full
  G3 from clean resources and cannot be downgraded.
- The decision is bound to commit/build/config/classifier digests.

## Phase 1: Delete Confirmed Duplication

### D1 Performer unreachable groups

Delete only groups proven unreachable from the installed CLI and undocumented
as a supported library surface. Remove each group's exclusive tests in the same
atomic deletion. Keep `codex_client` and every module in the CLI closure.

Confirmed groups after repository import, entrypoint, test, and history audit:

1. `D1.1`: 10 legacy Linear/tracker/tool modules, 1,276 lines, and 38
   exclusive nodes;
2. `D1.2`: three workspace/repository-handoff modules, 449 lines, and two
   exclusive nodes;
3. `D1.3`: three telemetry/one-strategy backend modules, 494 lines, and four
   exclusive nodes.

Together they own exactly 44 deletable pytest nodes. Seven involved test files
collect 52 nodes because eight Conductor runtime environment/profile tests in
`test_runtime_backend.py` remain. Keep nine functional CLI modules (1,670
lines), the one-line package `__init__.py` (1,671 retained lines total),
`codex_client`, and real Codex probes. Remove already-unused `Jinja2`
independently; remove `httpx` atomically with `D1.1`, its only remaining
consumers. Retain `openai-codex` and `performer-api`.

Verification per group:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src \
  .venv/bin/python -m pytest <retained-performer-tests> tests/test_import_boundaries.py -q
make test
```

### D2 Podium shadow service generation and PostgreSQL proof

Resolve all 39 `PodiumServer`-dependent nodes before deletion: migrate 38 HTTP
behavior tests to direct `create_app`/ASGI composition and delete the one
wrapper-only structural assertion. Then delete six shadow modules (559 lines),
`JsonStoreLegacyMixin` (78 lines), and exactly 34 additional exclusive
shadow/legacy nodes. Preserve the JSON capability mirror until replacement
proof exists.

The current suite has no real `PgStore` pytest connection: seven tests named as
injected PostgreSQL tests instantiate `PodiumStore`, and one lease test scans a
compatibility comment. Replace those claims with executable PostgreSQL
contracts using `PgStore.connect()` plus migrations for auth, runtime,
polling/checkpoints/delegation epochs, dispatch lease/ack/reap, and proxy audit.
The concurrency contract must prove `SKIP LOCKED`, reclaim, and stale-fence
rejection against real PostgreSQL.

`tools/real_podium_pg_multiworker_probe.py --help` currently fails on the
removed `podium.linear_polling` import and also expects deleted in-memory state.
Rewrite it against `LinearReconciler` and durable PostgreSQL state before JSON
retirement; an import rename alone is not sufficient.

### D3 Shared-contract and meta-test pruning

Move role-local models to their owner, remove unused exports, replace source-
string/order tests with public behavior or AST dependency checks, and publish
an invariant-owner registry plus entrypoint reachability check.

### G1 Checkpoint

- All non-E2E local tests and code-size gates pass. The paused E2E evidence
  failure is recorded as a named known-red and is not counted as a pass.
- Real PostgreSQL concurrency/recovery contracts execute without skips; Podium
  web tests, lint, typecheck, design lint, and clean wheel/install tombstones
  pass.
- Installed entrypoint reachability has no unexplained production module.
- No test-only production service generation remains for completed slices.
- Before/after production/test/tool LOC, test nodes, LOC per node, domain
  runtime, direct state-mutation counts, invariant-owner coverage, and
  duplicate-owner counts are recorded.
- Confirmed dead symbols and generated residue are absent, and an independent
  simplification reviewer approves the deletion foundation.

## Phase 2: Clean-Architecture Cutover (Behavior Preserving)

### Temporary scope lock

Through `G2`, treat every business capability currently listed in the
acceptance catalog as retained. This is a migration safety rule, not the final
product decision. Absence of a test or a recently deleted caller is not
evidence that the behavior was intentionally removed. In particular, the
current B16 Linear-dependency behavior must be characterized and migrated to
`DependencyOverlay` before `G2` can pass.

### Scope ledger for every slice

Before production edits, write the following five fields into the work item or
its implementation notes:

- `authorized`: exact user request, accepted contract, preserved behavior, or
  named in-scope defect/invariant that authorizes the slice;
- `required_consequences`: internal changes mechanically necessary to deliver
  `authorized`, with no additional customer-visible promise;
- `out_of_scope`: nearby behavior the slice deliberately will not change;
- `assumptions_requiring_approval`: any unresolved choice that could affect
  customer behavior, workflow branches, public API/DTOs, durable facts,
  configuration, integrations, permissions/cost, security, compatibility, or
  product vocabulary;
- `deferred_ideas`: potentially useful discoveries recorded without code or
  normative tests.

`assumptions_requiring_approval` must be empty before production work begins.
Purely internal, reversible implementation choices may proceed only when they
do not create a new observable/public/durable/external contract. Reviewers reject
any untraceable behavior as `UNAPPROVED_SCOPE_EXPANSION`; a test cannot make an
imagined feature part of the product contract.

### Target module shape

```text
HTTP/polling/process/Linear entrypoints
                 |
                 v
        application commands
                 |
                 v
      ManagedRunEngine.execute()
          |              |
          v              v
  pure decision owner   consumer-owned ports
          |              |
          v              v
 typed result/effects   SQLite/PostgreSQL/Linear/Git/process adapters
          |              |
          +------- atomic commit -------+
                         |
                         v
              read models / projection
```

- Commands, results, rejection codes, ids, and finite effects are contracts;
  they contain no database, HTTP, subprocess, Git, or Linear implementation.
- The engine owns load -> decide -> atomic state/effect commit. It does not own
  SQL strings, process spawning, or projection formatting.
- Planning, dependency, attempt, operator-wait, verification, and delivery each
  have one decision owner. Shared predicates such as readiness, terminality,
  capacity, and legal transitions are defined once.
- Repositories persist accepted decisions and compare revisions; they never
  decide whether a transition is legal. Ports are consumer-owned and
  capability-scoped rather than one giant `Any` store.
- External actions run only from committed, enumerable effects. Adapters parse
  and validate untrusted external data, translate it to commands, and translate
  snapshots to wire/read models.
- Composition roots are the only modules that select concrete implementations.
  Direct `getattr(store, ...)`, pass-through facades, and mixin-wide implicit
  interfaces do not count as dependency inversion.

### Migration method for every C slice

1. Complete the scope ledger and resolve every approval-requiring assumption.
2. Add characterization and boundary tests around the existing behavior.
3. Define the smallest consumer-owned contract and rejection semantics.
4. Route one complete use case through the new boundary.
5. Prove state, effect, error, log, and API parity, including crash/replay paths.
6. Delete the direct mutation path and any obsolete wrapper in the same slice.
7. Run an independent `code-simplification` review; behavior changes and
   simplification remain separate commits.

### C0.1 Add engine command/decision facade

Introduce a stable facade, typed command results, finite pending effects, and a
consumer-owned repository protocol without moving all existing files first.
Define the Podium-owned `DispatchLeaseRef` separately from the Conductor-owned
`TurnLease`; authority, lease id, fence, heartbeat/expiry, and stale error codes
cannot alias. No generic workflow registry or event-sourcing framework.

### C0.2 Add revision/idempotency commit

Add aggregate revision, command id, atomic state/effect commit, and idempotent
replay to SQLite. Include target tables for dependency overlays, TurnLeases,
and delivery records. Stores persist accepted decisions; they do not decide
legal transitions.

### P1.1 Add Podium capability-scoped ports

After the C0 contract is stable, define consumer-owned ports for auth,
installation, topology/binding, polling/reconciliation, dispatch, runtime
commands, and health. Route handlers and capability services receive only the
port they consume rather than `Any`, `ManagedPodiumState`, or the entire
`PgStore`. `PgStore` may remain the composition facade temporarily, but it is
selected only at the composition root and is not the application contract.

### P1.2 Make capability state and command writes atomic

For each Podium capability, converge competing direct append,
`enqueue_*_once`, and transaction-specific paths into one idempotent operation.
Begin with project binding plus the required `configure` command so retry cannot
leave a durable binding without its outbox command. Preserve polling-only page,
checkpoint, delegation-epoch, dispatch, and fencing semantics.

### T1 Add the local parallel feedback accelerator

In parallel after `G1`, separate environment bootstrap from fast non-E2E test
execution. Run independent static/docs, contract/unit, Conductor, Podium,
Performer, PostgreSQL, and web domains with non-one default concurrency and a
common structured result envelope. An always-run aggregator waits for every
independent sibling and reports all root causes once; only a named failed
ancestor may block its exact descendants. This slice does not repair, weaken,
or reinterpret the paused real E2E findings.

### C0.3 Make dispatch notification-only and acceptance atomic

`dispatch.available` is only a wake-up notification; Conductor leases the
durable Podium dispatch and receives a typed `DispatchLeaseRef` instead of
trusting a full pushed payload. In one repository transaction, enforce one run
per bound project plus Linear issue. Dispatch/delegation-epoch identity makes
the command idempotent but never creates another run for that issue. Replay
returns `created=false` and preserves every existing aggregate state and
revision.

### C1.1 Commit planning as one decision

Preserve the existing append-only accepted plan versions, but commit plan,
work items, frozen gates, approval disposition, and run state through one
planning command. Do not duplicate the existing plan validator or canonical
attempt views.

### C1.2 Add immutable dependency overlays

Add the overlay reducer, persistence, validation, and effective-readiness read
model. Effective readiness is immutable plan dependencies union the active
`DependencyOverlay`. Reject cycles, stale versions, partial observations, and
changes to already-started targets. Linear observation-to-command wiring stays
in `C3` ownership.

### C2.1 Migrate attempts to durable TurnLease reservations

Migrate both plan and work-item JSON attempts to one durable TurnLease source.
Persist a fresh fence, reservation, expiry, and heartbeat before emitting any
external start effect; keep existing canonical attempt views during migration.

### C2.2 Launch only from committed effects

An effect worker starts Performer only from a committed `StartTurn` effect.
Blocked work-item approval emits no effect and no attempt. Handle launch
failure, heartbeat, expiry, and crash recovery as typed outcomes. Plan-level
approval already blocks launch and needs only a regression proof.

### C2.3 Enforce real capacity

Compute global/per-role capacity from all active, non-expired TurnLeases across
all runs. A zero or exhausted global/role limit emits no reservation and no
start effect; remove the current zero-active input and minimum-one clamp.

### C2.4 Quarantine stale results

Stale dispatch and stale turn failures use distinct codes. A stale result is
retained as evidence and cannot fail current work or consume the current
TurnLease.

### C3.1 Separate operator commands from projection

Move complete Linear observations through `operator_events.py` into typed
engine commands, and remove operator-command ingestion from the projector.
During this slice projection consumes immutable snapshots for operator writes,
but temporarily retains `verified -> done` until delivery authority exists;
`C4.3` performs the final fully read-only cutover.

### C3.2 Migrate managed and runtime waits

Route managed approval/information waits and runtime approval/tool-input waits
through typed engine commands. Preserve the current durable wait identities,
Linear Human Action projection, sanitized reasons, retry counts, and next
actions while removing projection-owned transitions.

### C4.1 Assemble and verify the final candidate

Starting from the run's frozen base revision, merge every verified terminal
manifest deterministically, assemble the complete candidate, and independently
verify its exact commit. Leave the customer's checked-out branch unchanged.
Reuse the existing execution handoffs, manifests, branch join, and local
verifier instead of creating parallel representations.

### C4.2 Persist DeliveryAttempt before Git mutation

Reserve immutable candidate commit, expected-old ref, destination ref, and
effect identity in `DeliveryAttempt` before any Git ref mutation. Replaying the
same effect is idempotent; conflicting immutable inputs fail closed and remain
visible.

### C4.3 Reconcile Git ref to DeliveryRecord

Materialize `refs/heads/symphony/deliveries/<run_id>` with expected-old-value
protection. Crash after ref creation must replay the same outcome and converge
to `DeliveryRecord -> done`; only after this cutover does C4 receive the
projection file from C3 and remove projector-owned completion.

### C5.1 Cut over every state-writing caller

Migrate coordinator, driver, wait, branch-join, verification, sync, and
projection callers so they can only submit typed commands or consume immutable
snapshots. Remove public arbitrary state mutators from the repository surface.
Architecture tests reject direct run/work-item mutation outside the engine and
repository implementation.

### C5.2 Narrow composition roots and capability ports

Replace giant implicit `Any`/mixin dependencies with the smallest
consumer-owned capability ports at Conductor and Podium boundaries. Keep a
Protocol only when it represents an external/volatile seam or has multiple
implementations. Remove zero-value forwarding layers, duplicated parsers,
private cross-package helper imports, and unused one-off abstractions exposed by
the migration.

### C5.3 Prove canonical ownership and change radius

Publish the canonical owner for every command, state, lease, effect, wait,
delivery, wire DTO, and read model. Run three representative change-radius
audits: one role-local optional field, one cross-process wire field, and one new
adapter implementation. Each audit must identify the intentionally touched
owner and boundary translations; unrelated reducers, stores, projectors, and
tests must remain unchanged.

### G2 Checkpoint

- Every transition has one command/decision owner; repositories persist but do
  not decide, and projection is read-only.
- Every external action originates from a committed finite effect; crash,
  replay, stale-fence, idempotency, and atomic state/effect recovery pass.
- No direct run/work-item state mutator is callable from coordinator, driver,
  wait, join, sync, or projection code.
- `DispatchLeaseRef`, `TurnLease`, `DependencyOverlay`, `DeliveryAttempt`, and
  `DeliveryRecord` have distinct canonical owners and durable representations.
- Architecture checks reject infrastructure imports from decision modules,
  runtime-role cross imports, private cross-package helpers, giant `Any`
  repository seams, and duplicate canonical models.
- The three change-radius audits pass, all code-size findings are zero, and the
  independent simplification review finds no pass-through wrapper or
  speculative interface.
- Every production behavior and public/durable contract traces to its scope
  ledger; there is no `UNAPPROVED_SCOPE_EXPANSION` finding.
- Focused reducer/repository/process/Git tests, deterministic system happy and
  recovery paths, and real PostgreSQL expiry/reclaim contracts pass. Paused E2E
  known-red findings remain listed separately and cannot satisfy this gate.
- State, API, Linear projection intent, and structured log evidence agree.

## Phase 3: Product Scope Freeze And Function Pruning

No deletion begins merely because a module is large, hard to test, or currently
unreachable from one entrypoint. Scope is decided in business language first,
then represented as an executable manifest.

### F0.1 Build the capability/consumer inventory

Inventory at least authorization/OAuth, installation/project selection,
Conductor enrollment/binding, polling/delegation, dispatch/leasing, planning and
dependencies, Performer execution/runtime profiles, managed/runtime waits,
verification/delivery, Linear projection, operator views, and acceptance
evidence. For each capability record:

- actor, customer job, visible outcome, and canonical journey dependency;
- owning module and interface, real callers, durable data, configuration, API,
  logs, docs, and test owners;
- unique value versus overlapping implementations;
- maintenance/change-radius/test-runtime cost;
- proposed `keep`, `merge`, `remove`, or `defer` decision and replacement when
  applicable.

Role-local inventory work runs in parallel. The joined manifest must cover
100% of cataloged businesses and reachable production capabilities.

### F0.2 Approve one immutable scope manifest

Review the inventory with the product owner and freeze one versioned manifest.
No agent may infer that low usage, a missing test, or high LOC means removal.
`merge` and `remove` entries require an explicit replacement/migration path;
`keep` entries name their canonical owner and cheapest trustworthy test.

### F1 Retire or merge one capability per slice

For each approved item:

1. Migrate all active consumers to the retained owner or prove zero consumers.
2. Migrate or intentionally retire durable data, API fields, config, logs, and
   operator-visible state.
3. Remove old production code, exclusive tests, docs, dependencies, flags, and
   compatibility paths atomically.
4. Add tombstone/zero-reference proof and focused behavior evidence.
5. Run an independent simplification review and record before/after production,
   test, and tool LOC plus test-node/runtime impact.

After shared wire/schema changes land, non-overlapping Conductor, Podium,
Performer, and web slices run in parallel. A failure blocks only its dependent
slice; all independent slices finish and the join reports every root cause.

### F2 Converge duplicate concepts and test owners

After capability retirement, consolidate semantically duplicate ids, parsers,
time helpers, state fields, DTOs, read models, and error codes under their named
owners. Map every critical invariant to one cheapest owner test and at most one
distinct wiring/real-boundary test. Remove overlapping giant tests only after
the surviving owner proves the same fact.

### GF Lean-product checkpoint

- The approved scope manifest has no undecided reachable capability.
- Every retained business has one owner, entrypoint, state authority, and
  acceptance mapping; every removed/merged capability has zero code, data,
  config, API, docs, and test consumers.
- No compatibility shim or dormant feature flag keeps a retired path alive.
- Production/test/tool LOC, node count, LOC per node, runtime by domain,
  duplicate-owner count, and change-radius audits are recorded before/after.
- Deterministic retained-business tests and real PostgreSQL contracts pass.
- Real E2E work remains paused until the reduced scope is explicitly confirmed;
  known-red evidence is preserved rather than silently weakened.

## Phase 4: Parallel Feedback And Acceptance

### H1 Test domains and aggregate reporting

Promote the T1 local feedback foundation into the canonical CI and acceptance
prerequisite contract. Keep bootstrap separate from execution and retain
independent `static/docs`, unit/contracts, PostgreSQL, Podium, Conductor,
Performer, web, and system jobs. Each emits JUnit plus the common result
envelope. Use a non-one default worker count, let every independent job finish,
and run an always-run aggregator that returns every root cause in one report. A
job is `blocked` only when a named failed ancestor makes that exact job
impossible; siblings are never cancelled after another failure.

### H2 Compact scenario runner

Implement a validated check DAG, resource claims, work-conserving scheduler,
typed snapshot slices, pure oracles, append-only evidence, cleanup ledger, and
failed/blocked rerun selection. Every check declares validated `depends_on`
edges; resource claims must be minimal and cannot serialize an entire scenario
without an external-capacity reason. When two independent checks are runnable
and capacity exists, lack of observed overlap is a gate failure. Remove global
collaborator swapping and facade chains only after G4 parity.

### H3 Linear customer-experience reviewer

Build the complete issue/comment-version manifest for every real issue and
every comment version regardless of customer, Symphony, diagnostic, or Linear
system origin. Add deterministic hard checks, read-only browser/API
reconciliation, separate mandatory scores for meaning, value, clarity,
actionability, intuitiveness, correctness, safety, and usability, plus a
low-noise hard check, calibration fixtures, partitioned agent review, and a
schema-validated verdict. Canonical/focused scenario registration also consumes
the immutable impact decision, including operator-promoted localized changes;
promotion selects full clean-resource G3 and is never advisory.

## Phase 5: Live Journey And Cutover

1. Run deterministic system scenarios and every selected focused scenario.
2. Implement missing OAuth/installer/binding, full baseline/incremental polling,
   transactional checkpoint/delegation-epoch, smoke, and evidence prerequisites.
3. Run `customer_onboarding_to_completed_managed_run` through the real browser,
   default Linear app OAuth, real project/repository, Conductor, Performer, and
   Codex.
4. Prove exact delivery ref/commit/final verification/DeliveryRecord/done
   parity, 100% Linear artifact coverage, reviewer score >= 3, and cleanup.
5. Run one-time G4 catalog/fact parity; only then remove the superseded runner
   and `overall-dod` execution mode.

## Simplification Gate For Every Slice

After GREEN and before integration:

1. Re-read the composition root, callers, error paths, tests, and relevant git
   history.
2. Remove dead branches, forwarding wrappers, duplicate predicates, optional
   global stores, and speculative abstractions exposed by the slice.
3. Preserve inputs, outputs, side-effect ordering, errors, observability, and
   security exactly; do not weaken tests.
4. Use an automated transform for a mechanical rewrite over 500 lines.
5. Record before/after reachability, production/test LOC, invariant owners, and
   why the result is easier to understand.
6. Commit the behavior change and behavior-preserving simplification separately.
7. A new Protocol must have multiple production implementations or a documented
   consumer boundary seam; otherwise remove it as speculative abstraction.
8. Store/application `Any`, `getattr` dispatch, pass-through wrappers, facade
   depth, duplicate predicates/parsers, and LOC-per-test-node may not increase
   without an explicit reviewed reason.
9. Confirm the scope ledger still matches the final diff. Helpful discoveries
   remain deferred unless separately approved; no test or documentation change
   may silently broaden the authorized behavior.

## Verification Cadence

- Each RED test is executed and observed failing before production code.
- Each GREEN slice runs its focused tests and import-boundary checks.
- Every 2-3 slices run the full local suite.
- Every completed role boundary runs the deterministic system gate.
- Core/major completion requires the canonical real journey; mocks cannot raise
  its acceptance score above 2/4.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Hidden external consumers of Performer internals | Audit package exports, docs, entrypoints, repo imports, and history before deletion; stop if a supported surface is found |
| Large mixed migration diff | Exclusive file ownership, vertical slices, atomic commits, and full suite every 2-3 slices |
| New giant engine | Stable facade plus five package-internal reducers; shared policy limited to terminal/readiness/capacity |
| Git/database dual-write | Persist DeliveryAttempt/outbox before ref mutation; reconcile by immutable effect identity |
| Test count falls by hiding cases | Register invariant ownership; retain distinct boundary facts and real PostgreSQL/process tests |
| Live acceptance is slow or unavailable | Run all deterministic branches first in parallel; report external blockers explicitly and never claim pass |
| ADR/main intake drift returns | Keep polling-only vocabulary in executable docs/catalog tests and reject webhook/AgentSession paths at G0 |
| Parallel workflows silently serialize | Validate minimal resource claims, use non-one concurrency, record overlap, and fail unexplained serialization |

## Open Operational Inputs

- Real G3 requires a usable `.env`, public HTTPS OAuth callback origin, test
  Linear workspace/project, PostgreSQL, and staged Codex seed. Missing
  infrastructure blocks only G3/G4, not independent deterministic
  implementation.
- External consumers outside this repository cannot be inferred from source;
  any documented/supported Performer library consumer discovered during audit
  pauses the relevant deletion.
