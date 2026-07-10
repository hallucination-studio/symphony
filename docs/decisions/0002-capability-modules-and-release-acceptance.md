# ADR-0002: Capability-Aligned Modules And Journey-Based Release Acceptance

## Status

Proposed. This document does not authorize implementation and is not a current
product source of truth. Implementation planning starts only after this design
is reviewed and accepted.

## Date

2026-07-10

## Summary

Symphony will retain its four runtime packages while reorganizing code inside
those packages around business capabilities, explicit state ownership, and
stable contracts. The goal is to reduce change radius, eliminate accidental
duplicate implementations, and make state transitions and failure behavior
have one semantic owner.

Release acceptance will be organized around an explicit catalog of current
customer jobs, composed customer journeys, and named acceptance facts. One
canonical `customer_onboarding_to_completed_managed_run` journey will exercise
the real customer path through a browser, Linear OAuth, project selection,
Conductor installation and binding, webhook dispatch, a real Performer and
Codex run, verification, Linear customer-experience review, evidence archival,
and cleanup. It is mandatory for core or major changes and selectable on demand
for localized changes. Focused recovery and edge scenarios prove one additional
risk each. Full-function acceptance is the aggregate coverage of the
risk-selected suite, not one scenario that forces every branch to occur in a
single run.

Implementation will be parallel-first. A small contract and dependency
foundation is sequential; after that gate, role-owned workstreams proceed in
parallel with exclusive file ownership and explicit integration checkpoints.

## Context

Symphony is one product with four runtime roles:

- `podium` owns the hosted control plane, browser boundary, Linear
  installations, project selection, runtime enrollment and binding, intake,
  dispatch, proxying, and operator views.
- `conductor` owns one project's local durable Managed Runs state, repository,
  dispatch leases, Performer process lifecycle, verification, integration, and
  projection coordination.
- `performer` executes one fenced turn from a request file to a result file.
- `performer-api` carries contracts shared across runtime boundaries and must
  not become a general-purpose domain package.

The package boundaries are sound runtime boundaries and currently have no
internal dependency cycles. They must be preserved. The internal module shape,
however, has been driven heavily by file-size splitting and historical
transitions rather than durable business seams.

Read-only repository analysis found the following structural signals:

- Conductor has 66 flat Python modules and 30 mixin classes. Podium has 15
  mixin classes. Composition through mixins often hides dependencies that would
  otherwise be visible in constructor arguments or module ports.
- Managed Run state mutation is spread across approximately 41 call sites in
  nine files. `ConductorManagedRunStore.update_run_state` writes the requested
  state but does not own or validate the legal transition graph.
- `gate_status` acts as a machine state, error code, wait marker, and display
  string. Multiple components parse string prefixes to recover semantics.
- Podium contains overlapping service generations. Onboarding, secret
  encryption, OAuth URL construction, runtime status, and related models have
  both a synchronous/test-oriented implementation and an async production
  state implementation.
- The current Performer CLI reaches only the one-turn execution path, while a
  substantial Linear/tracker/workspace/repository-handoff surface remains in
  the package. Those modules appear to belong to an older runtime boundary and
  duplicate responsibilities now owned by Conductor and Podium. Reachability
  and external-consumer checks are required before removal.
- JSON and PostgreSQL storage implementations duplicate behavior legitimately
  as adapters, but there is no typed storage port defining their required
  parity.
- Python BFF payloads and TypeScript browser types are hand-maintained. This is
  legitimate boundary duplication, but state fields often degrade to `string`,
  so drift is difficult to detect.

The current real-run tooling has also become a second orchestration system:

- `tools/real_symphony_e2e*.py` contains 33 flat files and approximately 5,672
  lines. Its two main acceptance-tooling test files contain 140 tests.
- Scenario selection, prompts, fixtures, runtime policy, wait behavior,
  terminal rules, projection checks, and final scoring are distributed across
  many modules. Adding a scenario requires synchronized edits in multiple
  unrelated files.
- Work-item terminal normalization, projection parity, wait interpretation,
  and completion rules are reimplemented by the runner, observer, audit, and
  acceptance layers.
- The documented acceptance journey requires real browser OAuth, an initially
  unbound named Conductor, Podium-owned project binding, signed AgentSession
  webhook intake, reconciliation recovery, and external cleanup. The current
  runner instead requires a pre-supplied app access token and application id,
  directly enrolls a runtime, patches Conductor settings, and protects a
  polling-only path in source-level tests.
- The `overall-dod` scenario combines parallel execution, forced integration
  conflict, replan, runtime wait, crash recovery, and live policy changes. Its
  failures are causally ambiguous, and several requested outcomes are mutually
  exclusive in one run.
- The onboarding smoke route currently records a hard-coded passing result and
  therefore cannot serve as a release oracle.

## Objective

Refactor Symphony so that:

1. A normal requirement usually changes one business capability in the
   authoritative role, plus an explicit cross-role contract and acceptance
   fact only when the journey genuinely crosses those boundaries.
2. Every stateful concept has one semantic owner and one legal transition
   policy.
3. Persistence rows, API DTOs, projections, and UI view models are explicit
   representations of an owned concept rather than independent definitions of
   its behavior.
4. Every acceptance scenario states exactly what it proves, which authority is
   inspected, which operator surface must agree, and which artifacts are
   required.
5. The business scenario catalog states the actor, customer job, start state,
   accepted outcome, and visible product artifacts for every current workflow.
6. The acceptance suite includes one fully real customer journey using a real
   browser, real Linear, real Podium, real Conductor, real Performer, and real
   Codex.
7. An independent reviewer inspects every Linear issue and comment created by
   the canonical journey and fails unclear, low-value, misleading, unsafe, or
   unusable customer output.
8. Core and major changes cannot skip the canonical journey; localized changes
   select it on demand through an explicit, auditable impact decision.
9. Implementation work can proceed in parallel without overlapping ownership
   of shared contracts or core state-machine files.

The primary users of this design are engineers and coding agents changing
Symphony, release operators evaluating a build, and operators diagnosing a
failed real run.

## Assumptions

1. The four existing Python package boundaries remain runtime boundaries.
2. Conductor remains the sole owner of durable Managed Runs state and the sole
   local process manager for Performer.
3. Podium remains the only component that holds Linear OAuth tokens and the
   only public browser/BFF boundary.
4. Performer remains a short-lived, one-turn worker and does not acquire
   scheduling or Linear-installation responsibilities.
5. `performer-api` contains a contract only when at least two runtime roles
   serialize or consume it.
6. Whenever selected, the canonical journey must use real external systems.
   Focused fault scenarios may use deterministic fault injection when relying
   on accidental real-Codex behavior would make the result ambiguous.
7. The canonical journey starts from a fresh Podium account and uses the
   deployment-owned default Linear application. Customer-application setup and
   replacement are proved separately.
8. Conductor may stage the minimum approved execution credentials into isolated
   per-role runtime homes. Linear OAuth credentials never leave Podium, and no
   secret may enter browser responses, logs, reports, or evidence.
9. No implementation begins until this proposed design and its open questions
   are reviewed.

## Design Principles

### Capability Before Layer

The first partition is the business reason for change. Technical layers such as
routes, services, repositories, and schemas live inside a capability rather
than forming repository-wide horizontal layers.

### Explicit Authority

Every durable fact has one authority. Other roles may cache, report, or project
that fact, but they do not independently decide it.

### One Semantic Source, Multiple Explicit Representations

A concept may have a domain model, persistence row, API DTO, and UI view model.
Those representations are legitimate only when named translators and contract
tests make their relationship explicit. They must not each contain a separate
state machine.

### Centralized Transitions

Commands request transitions from an aggregate or transition service. Stores
persist accepted transitions; they are not the place where arbitrary callers
write any enum value. Invalid previous-state/command combinations fail closed
with a stable error code and visible reason.

### Optimistic Concurrency And Atomic Commit

Every mutable aggregate carries a monotonic revision. Commands carry a stable
`command_id`/idempotency key and the expected aggregate revision. Applying a
Performer result additionally requires the matching plan version, policy
revision, lease id, turn id, and fencing token.

The capability repository commits aggregate state, durable domain events, and
projection/report outbox entries in one transaction using compare-and-swap on
the expected revision. A stale revision fails with a stable
`stale_aggregate_revision` error and cannot partially write state or events.
Idempotent replay of an already committed command returns its prior outcome.

External effects occur after the commit through durable outbox work. Failed
projection/report delivery preserves retry count, latest sanitized error, and
next action without rolling back the authoritative transition.

### Structured Outcomes

Free-form status strings do not carry multiple protocols. At minimum, the
design introduces structured concepts for:

- `BlockReason`: kind, error code, sanitized reason, action required,
  retryability, and next action;
- `GateOutcome`: status, authoritative steps, evidence references, score, and
  failure details;
- `RuntimeWait`: wait kind, attempt, lease, message, child issue, and resume
  channel;
- `TransitionResult`: previous state, next state, command, event ids, and
  rejection details.

### Ports At External Boundaries

Linear, PostgreSQL/JSON storage, Git, subprocesses, Codex, clocks, and browser
automation are adapters behind narrow ports. Domain code does not import route
modules or concrete adapters.

Repository ports are capability-scoped. There is no repository-wide storage
interface that grows whenever any capability changes. A small transactional
unit-of-work port may compose multiple capability repositories only for a use
case that requires one atomic commit.

### Thin Composition Roots

`app.py`, CLI entry points, and package composition modules may have high
fan-out because they wire capabilities. Domain modules may not. High fan-out is
acceptable only at an explicit composition root.

### Acceptance Is Read-Only Observation Plus Explicit Action

Actors perform user or operator actions. Fault injectors inject one named
fault. Observers only collect state. Oracles are pure functions over typed
snapshots. A single object must not sample, mutate Linear, kill a process, and
decide acceptance.

### Error Visibility Is Part Of The Contract

No refactor may weaken the repository's durable-state, API, log, Linear, or
evidence parity requirements. Empty exception handlers and generic failed
states are architecture violations, not local cleanup items.

### Parallel-First, Conflict-Averse Delivery

Parallel implementation is the default after contracts are stable. Work is
parallelized by exclusive capability/file ownership, not by assigning multiple
workers to the same central module. Shared contracts and migration gates are
short sequential steps that unlock wider parallel execution.

## Capability Map

| Capability | Authority | Primary responsibilities | Required operator proof |
|---|---|---|---|
| Identity and Session | Podium | Registration, login, session, bootstrap, logout | Browser session and sanitized account state |
| Linear Installation | Podium | Default/custom app config, OAuth state/callback, candidate/active/cutover/revoke, token health | Installation identity, actor, scopes, organization, app user, token health |
| Project Selection and Binding Intent | Podium | Project selection, named runtime, enrollment, online-unbound state, desired project/repo binding, label intent | Selected project, unique desired binding, exact label intent |
| Runtime Config and Repository Health | Conductor | Validate staged project/repo config, persist acknowledged config revision, report repository readiness | Acknowledged config and repository health match Podium's desired binding |
| Intake and Routing | Podium | Signed webhook, reconciliation cursor, dedupe, organization/project/app-user/binding/blocker/capacity eligibility | One normalized intake creates at most one eligible dispatch |
| Dispatch Queue and Lease | Podium | Queue, wakeup, durable lease, fencing generation, heartbeat, ack, expiry, reclaim | Correlated queue/lease/ack with no duplicate ownership |
| Managed Run | Conductor | One parent to one run, plan versions, work-item graph, readiness, checkpoints, run/work-item transitions | Durable run and work items match the accepted plan |
| Attempt and Turn Lifecycle | Conductor | Accept dispatch lease, create attempt, materialize runtime profile, launch/monitor Performer, accept or reject fenced result | Local attempt and accepted outcome match the current lease and aggregate revision |
| Execution Result Claim | Performer | Validate one request, invoke one backend turn, emit progress, atomically write one claimed result | Result contains complete fenced context and correlated events |
| Verification and Integration | Conductor | Frozen gates, independent verification, score, manifest, deterministic join, conflict escalation | Verified evidence or visible actionable failure |
| Projection and Operator Interaction | Conductor | Publish Managed Runs reports and Linear projection intent; own managed/runtime wait resume transitions | Authority, Podium API, Linear, and logs show the same sanitized truth |
| Release Evidence Verdict | Acceptance runner | Collect typed snapshots, run pure oracles, archive artifacts, score requirements, clean resources | Complete hashed evidence and cleanup-before/after parity |

## Authority Rules

| Fact | Authority | Derived representations |
|---|---|---|
| Active Linear installation | Podium installation aggregate | Browser health view, proxy resolution, acceptance snapshot |
| Selected project and desired binding | Podium topology aggregate | Conductor staged config, Linear managed label intent, project UI |
| Acknowledged config revision and repository health | Conductor instance aggregate | Podium binding health, runtime detail view, logs |
| Dispatch availability, durable lease, and lease fencing generation | Podium dispatch aggregate | Conductor lease client view, Podium operator view, logs |
| Managed Run, plan, work-item state | Conductor Managed Run aggregate | Podium Managed Runs report, Linear projection, acceptance snapshot |
| Performer result claim | Performer result file | Conductor result collector input, Performer log |
| Accepted attempt outcome | Conductor Managed Run aggregate after revision and fencing checks | Attempt record, Podium report, Linear projection comment |
| Verification and manifest | Conductor verification/integration aggregate | Podium view, Linear summary, evidence bundle |
| Human/runtime wait resume | Conductor durable wait record | Linear blocked state or Human Action child, Podium view |
| Release verdict | Pure acceptance oracle over collected snapshots | Final report and per-requirement score |

Linear and Podium projections are never allowed to mutate Conductor's Managed
Run state except through an explicitly recorded operator event and the owning
transition service.

## Concurrency And Unit Of Work Contract

The state model uses capability-scoped repositories with explicit revision and
idempotency semantics:

```python
@dataclass(frozen=True)
class ManagedRunCommand:
    command_id: str
    run_id: str
    expected_revision: int
    kind: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class TransitionResult:
    command_id: str
    run_id: str
    previous_revision: int
    next_revision: int
    previous_state: ManagedRunState
    next_state: ManagedRunState
    events: tuple[DomainEvent, ...]


class ManagedRunRepository(Protocol):
    def commit(
        self,
        result: TransitionResult,
        *,
        outbox: tuple[OutboxMessage, ...],
    ) -> CommittedTransition:
        """Atomically CAS state/revision and append events/outbox records."""
```

Required guarantees:

- `expected_revision` is checked in the same transaction as the write;
- `command_id` is unique per aggregate and provides idempotent replay;
- state, attempt/event records, and outbox messages commit atomically;
- stale fencing, lease, plan, policy, turn, or revision values cannot mutate
  current state;
- projection and report workers consume outbox messages at least once and use
  stable replay keys for idempotent external writes;
- retry state and the latest sanitized delivery error are durable;
- SQLite and PostgreSQL adapters prove the same capability-level concurrency
  contract with adapter-appropriate transaction mechanisms.

## Target Code Structure

The exact filenames may change during implementation review, but the capability
and dependency directions are normative.

### performer-api

```text
packages/performer-api/src/performer_api/
  managed_runs/
    state.py          # shared enums and serialized state contracts
    plan.py           # plan/work-item/checkpoint contracts
    turns.py          # fenced request/result and runtime-wait contracts
    results.py        # canonical turn result and event contracts
    gates.py          # gate, verification, manifest contracts
    runtime.py        # role profiles, policy, capacity, config envelope
  ops/
    models.py
    projection.py
    retention.py
  config/
    codex.py
    sanitization.py
```

Rules:

- It may contain stable serialization and validation shared by multiple roles.
- It must not contain Podium-only installation or authentication domain logic.
- It must not import any runtime role.
- A facade may expose the supported public contract, but wildcard re-export
  chains are prohibited.

### performer

```text
packages/performer/src/performer/
  application/
    turn_runner.py
  protocol/
    request.py
    result.py
    runtime_wait.py
  backends/
    codex/
      client.py
      events.py
      errors.py
      schemas.py
  cli.py
  composition.py
```

Rules:

- The CLI reads one request, validates one fenced context, executes one turn,
  and atomically writes one result.
- Linear polling, dispatch leasing, repository ownership, and durable Managed
  Run state are prohibited.
- Suspected legacy modules are deleted only after reachability, packaging, and
  external-consumer audits. They are not reorganized into the new tree merely
  to preserve them.

### conductor

```text
packages/conductor/src/conductor/
  managed_runs/
    aggregate.py
    transitions.py
    planning.py
    execution.py
    verification.py
    integration.py
    waits.py
    repository.py
    service.py
  runtime/
    manager.py
    process.py
    logs.py
    profiles.py
  linear/
    gateway.py
    projection.py
    dependency_ingestion.py
  podium/
    channel.py
    dispatch.py
    reporting.py
    config.py
  instances/
    model.py
    repository.py
    service.py
  api/
    routes.py
    schemas.py
  composition.py
  cli.py
```

Rules:

- `managed_runs.aggregate` and `transitions` are the only modules that decide
  legal run/work-item transitions.
- Persistence repositories store and load aggregates; callers do not write
  arbitrary state directly.
- Projection, runtime, Git, and Podium clients are adapters invoked by
  application services.
- The production composition path must wire dependency ingestion, waits,
  projection, and background failure reporting. A module covered only by a
  direct unit test is not considered integrated.

### podium

```text
packages/podium/src/podium/
  auth/
    routes.py
    service.py
    repository.py      # capability-scoped protocol
    schemas.py
  installations/
    routes.py
    service.py
    repository.py      # capability-scoped protocol
    schemas.py
  onboarding/
  bindings/
  intake/
  dispatch/
  runtime_ops/
  linear_proxy/
  managed_runs/
  background/
    supervisor.py
  infrastructure/
    unit_of_work.py
    postgres/
    json/
  app.py
  composition.py
  cli.py
```

Each capability uses the same internal shape only when that shape is useful;
empty ceremonial layers are not required. Routes validate and translate, a
service owns use cases, and repositories/adapters own persistence and external
I/O.

Rules:

- One production state/service path replaces the current shadow service
  generation.
- Every capability owns its narrow repository protocol. JSON and PostgreSQL
  adapters implement those protocols and run the same capability-level
  contract suites. A unit of work composes repositories only when one use case
  requires an atomic multi-capability transaction.
- Webhook and reconciliation intake call one normalization, routing, and
  idempotency service.
- Background jobs run under a supervisor that records correlated sanitized
  failures in logs and durable health state. `except Exception: pass` is
  prohibited.
- `app.py` wires capabilities and does not implement business rules.

### Podium Web

```text
packages/podium/web/src/
  features/
    account/
    onboarding/
    integrations/
    projects/
    runtimes/
    managed-runs/
  shared/
    api/
    components/
    errors/
  locales/
```

Browser DTOs are generated from or contract-tested against sanitized BFF
schemas. Domain states use closed unions rather than `string | ...` escape
hatches unless forward compatibility explicitly requires an unknown variant.

## Module Interface Rules

1. Each capability exposes one supported facade or application service.
2. Cross-capability imports target that facade, never another capability's
   storage rows, route functions, or private helpers.
3. Domain modules depend on ports; adapters implement ports; composition roots
   instantiate both.
4. Shared serialization crosses runtime roles through `performer-api`.
5. Role packages never import each other.
6. Internal import-boundary tests enforce the allowed dependency directions.
7. No `common.py` or `shared.py` module may accumulate unrelated business
   rules. A helper belongs to the capability whose invariant it protects.
8. No new mixin is introduced solely to satisfy a line-count limit.
9. Capability repositories implement the revision/idempotency/unit-of-work
   contract defined above; stores do not decide transition legality.

## Duplicate-Concept Migration Policy

Every apparent duplicate is classified before editing:

1. **Canonical domain definition:** keep and make ownership explicit.
2. **Boundary representation:** keep, rename if needed, and add a translator and
   contract test.
3. **Projection/read model:** keep only if it is derived and cannot mutate the
   authority.
4. **Adapter parity:** keep multiple adapters behind one port and shared
   contract tests.
5. **Accidental duplicate or legacy path:** delete after reachability and
   external-consumer verification.

The migration does not preserve internal compatibility aliases indefinitely.
Each slice updates all in-repository consumers atomically. Public API and CLI
changes require separate approval and migration design.

Initial duplicate candidates include:

- Podium onboarding service versus `PodiumStateBaseMixin` onboarding logic;
- Podium `AuthService` secret crypto versus state-owned crypto;
- Podium OAuth URL construction in multiple service/route paths;
- synchronous test server/service models versus the production async state
  path;
- Performer Linear/tracker/workspace paths that are unreachable from the
  current CLI;
- repeated Managed Run active/blocked/terminal classifications in Conductor,
  Podium reports, frontend views, and the acceptance runner;
- repeated status normalization and projection parity logic across E2E runner,
  observer, audit, and final acceptance;
- legacy graph-shaped and current Managed Run-shaped acceptance payloads kept
  simultaneously despite the repository's hard-break policy.

## Test Architecture

Tests are organized by the boundary they prove, not by historical filename
size.

```text
tests/
  unit/
    performer_api/
    performer/
    conductor/
    podium/
    acceptance_runner/
  contract/
    runtime_roles/
    storage/
    bff/
    import_boundaries/
  integration/
    performer/
    conductor/
    podium/
  system/
    managed_runs/
    dispatch/
    recovery/
  acceptance/
    catalog_contracts/
```

Test levels are:

- **Unit:** pure parsers, models, state transitions, sanitizers, and oracles.
- **Contract:** cross-role DTOs, API schemas, capability repository/concurrency
  parity, import boundaries, browser sanitization, and acceptance catalog
  completeness.
- **Integration:** one role with real filesystem, SQLite/PostgreSQL, Git, ASGI,
  or subprocess behavior and controlled external adapters.
- **System:** real local Podium/Conductor/Performer processes with deterministic
  external adapters or fault injection.
- **Live acceptance:** real browser, OAuth, Linear, webhook origin, Conductor,
  Performer, and Codex where required by the scenario.

The default `make test` remains free of live external dependencies. Proposed
target commands, which do not exist until implementation, are:

```bash
make test-unit
make test-contract
make test-integration
make test-system

PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools \
  .venv/bin/python -m symphony_acceptance catalog

PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools \
  .venv/bin/python -m symphony_acceptance run \
  --suite risk-selected \
  --impact-file .test-real-flow/change-impact.json \
  --out .test-real-flow/risk-selected-acceptance
```

`test_real_run_tools_part1.py` and `part2.py` are acceptance-tooling unit tests,
not E2E scenarios. They are replaced by behavior-named runner tests. Source-string and
source-order assertions are replaced by public contract or runtime behavior
checks.

## Release Acceptance Model

### Business, Scenario, And Journey Contracts

The executable catalog distinguishes a customer job from the test that proves
it and from a composed journey. This prevents technical probes from being
reported as if they were businesses:

```python
BusinessScenarioSpec(
    id="B13_delegated_issue_to_verified_delivery",
    actor="project_member",
    customer_job="Delegate a real business issue and receive verified delivery.",
    start_state="routing_ready_project_with_delegated_issue",
    accepted_outcome="verified_change_and_completed_managed_run",
    visible_artifacts=("linear_issue_tree", "podium_managed_run", "repository_result"),
)

AcceptanceScenarioSpec(
    id="delegated_issue_to_verified_delivery",
    proves="One delegated issue produces one verified, observable delivery.",
    business_scenarios=("B13_delegated_issue_to_verified_delivery",),
    minimum_level="system",
    real_boundaries=(),
    authoritative_oracles=("dispatch", "managed_run", "repository"),
    operator_oracles=("podium", "linear", "logs"),
    required_evidence=("turns", "linear_tree", "repository", "cleanup"),
    trigger_tags=("managed_delivery", "manual"),
)

JourneySpec(
    id="customer_onboarding_to_completed_managed_run",
    proves="A new customer can reach a verified Managed Run through the supported journey.",
    business_scenarios=("B01a_register_workspace_account", "B01c_sign_out_workspace_session", "B02_authorize_default_linear_app", "B06a_select_managed_project", "B07_install_named_conductor", "B08_bind_project_repository", "B13_delegated_issue_to_verified_delivery", "B14_understand_managed_delivery"),
    preconditions=("clean_database", "fresh_podium_account", "default_linear_app", "real_linear_project", "staged_codex_seed"),
    real_boundaries=("browser", "linear", "podium", "conductor", "performer", "codex"),
    authoritative_oracles=("installation", "binding", "dispatch", "managed_run"),
    operator_oracles=("podium", "linear", "logs", "linear_customer_experience"),
    required_evidence=("installation", "runtime", "turns", "linear_tree", "linear_experience_review", "cleanup"),
    trigger_policy=("core_change", "major_change", "manual"),
)
```

The catalog is the source for CLI registration, documentation tables, required
checks, and report aggregation. Scenario names and requirements are not copied
into independent allowlists across runner modules.

Each atomic `AcceptanceScenarioSpec` obeys:

> one user intent + at most one decisive fault + one clear terminal oracle

A `JourneySpec` is an explicit ordered composition of those customer jobs. It
may span several intents only because its contract names every component and
has one customer-level terminal outcome. A technical probe must reference at
least one business scenario and explain the customer risk it protects.

### Current Business Scenario Catalog

This catalog is derived from the current product documents. It records current
product jobs, not a claim that every job already has adequate live acceptance.
Coverage gaps stay visible until a named target scenario closes them. Each row
has one customer intent and one accepted outcome; parameterized causes are
allowed only when the customer action and terminal outcome remain the same.

#### Account And Linear Integration

| ID and customer job | Start -> accepted outcome | Customer-visible surface | Target acceptance and current gap |
|---|---|---|---|
| `B01a_register_workspace_account`: create a workspace account | No account -> authenticated usable account | Podium registration, account, and bootstrap | Canonical journey |
| `B01b_sign_in_existing_workspace`: return and sign in | Existing account without a session -> authenticated usable account | Podium login, account, and bootstrap | `workspace_account_access`; current canonical gap |
| `B01c_sign_out_workspace_session`: end the current session | Authenticated session -> cookie invalid and protected bootstrap rejected | Podium logout and signed-out state | Canonical journey |
| `B02_authorize_default_linear_app`: authorize the default app | No active installation -> healthy workspace app installation | Podium actor/scopes/org/app-user/token/webhook health; Linear app actor | Canonical journey |
| `B03_activate_customer_owned_linear_app`: configure a custom app for the first time | No custom installation -> accepted active installation | Podium fixed callback/webhook URLs and candidate health; Linear app identity | `customer_owned_app_activation`; current live gap |
| `B04_replace_active_linear_app`: replace an app without disrupting work | Old app active -> new app active only after drain and runtime acknowledgement | Podium active/candidate/cutover/retired generations | `oauth_candidate_cutover` |
| `B05a_reconnect_linear_installation`: repair a broken integration | Unhealthy installation -> healthy active installation | Podium actionable error, reconnect, and recovered health | `linear_installation_reconnect`; current full-journey gap |
| `B05b_revoke_linear_installation`: disconnect an installation | Active unwanted installation -> revoked and unroutable | Podium revoke result and disabled routing state | `linear_installation_revoke`; current full-journey gap |

#### Project And Runtime Scope

| ID and customer job | Start -> accepted outcome | Customer-visible surface | Target acceptance and current gap |
|---|---|---|---|
| `B06a_select_managed_project`: add a project to Symphony scope | Accessible unselected project -> selected and manageable | Podium project access/selection health; unchanged Linear membership | Canonical journey |
| `B06b_deselect_managed_project`: remove a project from Symphony scope | Selected unbound project -> safely deselected and unroutable | Podium deselection/routing health; unchanged Linear membership | `project_deselection`; current canonical gap |
| `B07_install_named_conductor`: install a named runtime | No runtime -> online, isolated, initially unbound Conductor | Podium name/public id/host/service/version/heartbeat/data root | Canonical journey |
| `B08_bind_project_repository`: bind and validate project plus repository | Online unbound runtime -> routing-ready binding | Podium binding/repository/config/smoke health; Linear managed-project label | Canonical journey plus `routing_guards` |
| `B09_add_second_project_runtime`: add another project on the same host | One active runtime -> second isolated project runtime | Podium independent runtime/project state and Linear labels | `runtime_same_host_isolation`; current partial coverage |
| `B10a_rename_runtime`: change a Conductor's display identity | Healthy named runtime -> same runtime healthy under the new unique name | Podium operation state; updated Linear label | `runtime_rename` |
| `B10b_replace_runtime`: replace a project runtime | Existing runtime/binding -> new healthy runtime owns the project after drain | Podium replacement/drain/binding state; Linear label | `runtime_replacement` |
| `B10c_unbind_runtime`: remove runtime ownership from a project | Bound runtime -> drained, unbound, dispatch-disabled runtime | Podium operation/binding state; removed Linear label | `runtime_unbind` |
| `B10d_rebind_runtime`: assign an unbound runtime to a project again | Online unbound runtime -> acknowledged routing-ready binding | Podium binding/repository/config state; Linear label | `runtime_rebind` |
| `B11a_update_runtime`: move a runtime to a healthy target version | Healthy old version -> healthy new version | Podium channel/version/health | `runtime_update` |
| `B11b_rollback_runtime`: restore the prior runtime version | Failed/unhealthy update -> prior version restored and healthy | Podium version/health/rollback operation | `runtime_rollback` |
| `B12a_rotate_runtime_credentials`: rotate scoped runtime access | Valid or compromised credential -> old revoked, new credential healthy | Podium credential state and audit event | `runtime_credential_rotation`; current live gap |
| `B12b_suspend_runtime_routing`: stop new work safely | Routing-ready runtime -> dispatch disabled after required drain | Podium routing/drain state | `runtime_routing_suspension`; current live gap |
| `B12c_resume_runtime_routing`: restore new work safely | Healthy routing-disabled runtime -> dispatch enabled | Podium routing/config health | `runtime_routing_resume`; current live gap |
| `B12d_inspect_runtime_logs_and_audit`: diagnose runtime activity | Runtime operation or incident -> scoped sanitized logs and audit trail understood | Podium log and audit views | `runtime_log_audit_access`; current live gap |

#### Daily Managed Delivery

| ID and customer job | Start -> accepted outcome | Customer-visible surface | Target acceptance and current gap |
|---|---|---|---|
| `B13_delegated_issue_to_verified_delivery`: delegate real work and receive verified delivery | Routing-ready project plus delegated issue -> verified repository change and Managed Run Done | Linear root/work items/comments/summary; Podium Managed Runs; repository result | Canonical plus repeatable `delegated_issue_to_verified_delivery` |
| `B14_understand_managed_delivery`: follow and diagnose delivery | Active, blocked, failed, or completed run -> customer understands progress, evidence, cause, and next action | Podium run/work-item/gate/wait/error views; Linear projection | Canonical experience reviewer plus `managed_run_observability` |
| `B15_resume_deferred_dispatch`: wait through blockers or capacity | Delegated but ineligible issue -> exactly one run after eligibility returns | Podium skip reason/queue/capacity; Linear issue state | `deferred_dispatch_recovery`; `routing_guards` currently proves only rejection |
| `B16_add_linear_dependency`: add a dependency in Linear | Active plan -> validated union dependency changes execution order | Linear `blocks` relation and work-item order; Podium run state | `linear_dependency_ingestion`; current acceptance gap |

#### Human Collaboration And Recovery

| ID and customer job | Start -> accepted outcome | Customer-visible surface | Target acceptance and current gap |
|---|---|---|---|
| `B17a_approve_managed_plan`: approve a proposed plan | `awaiting_approval` -> recorded root state flip starts execution | Linear root instruction/status; Podium managed wait | `plan_approval`; previously hidden inside generic managed wait |
| `B17b_approve_work_item_gate`: approve one gated work item | Ready plan with gated child -> recorded child approval makes that item eligible | Linear work-item instruction/status; Podium gate/wait | `work_item_approval`; current focused-scenario gap |
| `B18_supply_missing_business_input`: unblock managed work | Parent or work item blocked -> supplied context and state flip resume it | Linear blocked issue with concrete instruction; Podium reason/wait | `managed_information_wait` |
| `B19_resolve_runtime_input_wait`: answer approval, permission, or tool input | Runtime wait -> completed `[Human Action]` child resumes the same wait | Linear Human Action child; Podium runtime-wait metadata | `runtime_wait` |
| `B20_approve_plan_revision`: approve changed scope or dependencies | Plan v1 insufficient -> immutable accepted v2 | Linear updated/new/canceled children, refreshed `blocks`, revision context | `plan_revision` |
| `B21_receive_verified_rework`: recover from failed verification | Verification failure -> corrected attempt passes without hidden evidence loss | Linear failed/passed attempt evidence; Podium verification history | `verification_rework` |
| `B22_resolve_integration_conflict`: resolve conflict and finish delivery | Integration conflict -> explicit decision or resolver work, then completion | Linear action/wait/final summary; Podium integration state | `integration_conflict_resolution`; current coverage stops at action required |

Business scenarios are not automatically live E2E executions. Each one maps to
the cheapest level that can prove its authority and customer-visible result.
The canonical journey composes the most important happy path; focused live
scenarios are reserved for external boundaries or human interactions that a
deterministic system test cannot prove.

### Versioned Real-Business Fixture

The canonical journey does not invent a new prompt on every run. It references
one versioned `BusinessFixtureSpec`, initially
`managed_delivery_small_feature_v1`, that fixes:

- the customer persona, natural-language business issue, and preserved original
  request;
- the fixture repository baseline commit and dependency lock hashes;
- observable business behavior before and after the change, including RED and
  GREEN commands;
- allowed implementation variation and forbidden out-of-scope behavior;
- expected customer-visible artifact kinds, without requiring exact model
  wording, fixed work-item ids, or a predetermined plan shape;
- maximum work-item and runtime budget, plus deterministic cleanup data.

The fixture must read like customer work, not a test instruction. It cannot
mention E2E mechanics, hidden node ids, expected model phrasing, or the rubric.
Changing the issue, repository baseline, expected outcome, or artifact contract
creates a new immutable fixture revision so results remain comparable.

### Feedback Aggregation Contract

Acceptance must report every independently discoverable root cause from one
execution. It must never claim that a downstream fact was checked when an
upstream dependency prevented that check.

The execution rule is:

> fail fast within one dependency branch; collect all across independent branches

Required behavior:

1. Preflight checks for configuration, PostgreSQL, ports, public HTTPS,
   browser/OAuth readiness, Linear access, Codex connectivity/seed, fixture Git
   state, and stale resources run in parallel and report all failures together.
2. Deterministic unit, contract, integration, and affected system scenarios run
   before expensive live work. A failed deterministic prerequisite prevents
   only the live branches that depend on it.
3. Within a scenario, a decisive blocker stops further mutating actions on that
   branch immediately. The runner still performs read-only diagnostics,
   archives evidence, and records the exact dependency that was not evaluated.
4. Every scenario declares an acyclic check-level graph with stable check ids
   and explicit `depends_on` edges. Catalog validation rejects missing,
   circular, or unjustifiably broad dependencies. A check may be `blocked` only
   when a named failed/blocked ancestor makes that exact observation impossible;
   independent siblings must still execute.
5. If a live branch fails after creating any Linear artifact, failure
   finalization builds and reviews the partial artifact manifest before cleanup.
   A failed business outcome never suppresses review of already-visible failure,
   wait, issue, or comment content.
6. Independent scenarios continue, subject to external concurrency and
   isolation limits. One scenario failure cannot abort the entire suite.
7. Every check ends in exactly one state:
   - `passed`: the fact was observed and met its oracle;
   - `failed`: the fact was observed and violated its oracle;
   - `blocked`: a named upstream root cause prevented evaluation;
   - `not_evaluated`: the fact was outside the selected impact scope.
8. Final reporting groups symptoms under stable root causes. A single OAuth,
   binding, or runtime-configuration defect is reported once with the complete
   list of affected/blocked facts rather than as many unrelated failures.
9. Known failures are emitted immediately with sanitized reason and evidence;
   the runner never waits for a global timeout after a concrete blocker is
   known.
10. Development reruns may select only failed and blocked scenarios whose
   dependency or relevant code/config hash changed. The final required gate
   reruns the complete risk-selected suite from clean resources.

The final report includes:

```json
{
  "impact_decision": {},
  "check_dependency_graph": {},
  "root_causes": [],
  "failed": [],
  "blocked": [],
  "not_evaluated": [],
  "passed": [],
  "scenario_results": [],
  "linear_experience_review": {},
  "artifacts": [],
  "cleanup": {}
}
```

Each blocked item records `blocked_by`, the last completed stage, and the next
action required to make it evaluable. This contract optimizes the developer
feedback loop without weakening fail-closed product behavior.

### Canonical `customer_onboarding_to_completed_managed_run` Journey

The risk-selected suite contains one fully real customer journey when the
change policy requires it or an operator requests it:

1. Start Podium against a clean PostgreSQL database with a public HTTPS
   callback/webhook origin and logs directed to the evidence root.
2. In a real browser, register a fresh Podium account and verify the new
   session/bootstrap state.
3. Choose the deployment-owned default Linear application and complete real
   Linear OAuth as a workspace admin with `actor=app`.
4. Verify one-time OAuth state, required scopes, real organization,
   workspace-specific app user, token metadata, project access, and absence of
   secrets from browser responses.
5. Select the real test project without changing project membership.
6. Generate a named Conductor enrollment command and execute the generated
   installer path. Verify the token is single-use and the isolated Conductor is
   online but unbound.
7. In Podium, bind the selected project and staged fixture repository. Verify
   Conductor validation and durable config acknowledgement, one-project/one-
   Conductor constraints, and the exact managed project label.
8. Run the real onboarding smoke check over installation, project, runtime,
   repository, proxy, config, and webhook health.
9. Materialize the exact natural-language issue from the selected immutable
   `BusinessFixtureSpec` revision and delegate it to the installed workspace app
   user.
10. Verify one signed AgentSession webhook creates exactly one eligible
    dispatch for the bound Conductor.
11. Verify the Conductor leases and acknowledges that dispatch and creates or
    resumes exactly one durable Managed Run.
12. Let real Performer turns and real Codex complete plan, work-item execution,
    independent verification, manifest publication, checkpoint, and final
    projection.
13. Verify repository behavior and tests, Conductor durable state, Podium
    Managed Runs, Linear issue topology/comments/summary, and correlated logs
    all describe the same terminal result.
14. Wait for a stable Linear projection, then build a complete versioned
    manifest of every issue, description, relation, status, label, summary
    block, and comment in the scenario's real Linear issue tree.
15. Capture every issue and comment through the real Linear UI, reconcile the
    captures against fully paginated API data and Conductor's durable projection
    map, and run the independent Linear customer-experience reviewer. Require
    complete coverage plus passing deterministic and semantic gates.
16. Log out and verify the browser session is invalidated while Podium and its
    database are still running; retain the browser/session evidence.
17. Freeze and recursively scan all candidate evidence before cleanup, without
    traversing any credential root.
18. Record cleanup-before state, clean every registered external/local resource
    idempotently, record cleanup-after state, then finalize and scan the complete
    evidence bundle. Cleanup failure is a failed result with retained evidence.

The selected business fixture is natural and small. It may describe two ordered
deliverables if dependency-ready scheduling must be observed, but it must not
require fixed node ids, test mechanics, or model-specific wording.

### Independent Linear Customer-Experience Reviewer

The canonical journey includes a second agent whose only job is to assess the
customer experience of Symphony's real Linear projection. This reviewer is not
the implementing Performer, planner, verifier, or scenario driver.

The reviewer:

- runs under a fixed, versioned reviewer profile, model configuration, rubric
  revision, prompt hash, and deterministic decoding parameters;
- receives no hidden implementation narrative or success claim from the agent
  that performed the work;
- consumes frozen captures produced by a read-only browser actor that opens the
  parent and every child, expands descriptions, summary blocks, comments,
  threads, and collapsed regions, and scrolls until no more content can load;
- cross-checks browser-visible content against the fully paginated sanitized
  Linear API tree and durable projection map so collapsed, missing, orphaned,
  stale, or duplicated artifacts cannot be skipped;
- cannot comment, change state, resolve a wait, edit a description, access the
  repository, or influence the scenario. The actor rejects any Linear GraphQL
  mutation or other write request as a failed hard check;
- emits schema-validated structured JSON plus a concise operator report.

Linear issue and comment content is untrusted input. It can describe customer
work, but it can never instruct the reviewer to ignore the rubric, use tools, or
change a score. Suspected prompt injection is recorded as a finding and is not
executed.

#### Artifact Coverage

Before review, the runner creates a `LinearArtifactManifest` containing stable
ids, versions, origins, authority references, and hashes for:

- the customer-created business issue and its preserved original request;
- every Symphony-created work-item or Human Action child issue;
- every issue title, description, state, parent, relation, label, and relevant
  projection-metadata fragment;
- every customer, Symphony, Linear-system, and explicitly marked diagnostic
  comment, including each customer-visible update version captured during the
  run;
- every managed-wait, runtime-wait, revision, cancellation, rework, conflict,
  and completion artifact;
- the root summary block and final completion report.

Every manifest entry has an origin: `customer`, `symphony`, `diagnostic`,
`linear_system`, or `unknown`. `unknown` is a hard failure. Every issue and
comment review unit is inspected and scored. Origin-specific rubric wording
prevents blaming a customer for their prose: customer units are scored on
whether Symphony preserves, contextualizes, and responds to their intent;
diagnostic units on whether they are safely separated and non-confusing; and
Linear-system units on whether the combined workflow remains understandable.
Diagnostic artifacts must be clearly identified as diagnostics and must not
resemble business instructions.

Fragments are the coverage unit; review units are the scoring unit. One issue
review unit combines its title, description, state, hierarchy, relations, and
links. Each comment version is its own review unit. This avoids assigning a
standalone state field a prose score while still proving that every visible
fragment was consumed.

The API collector must exhaust pagination with `pageInfo.hasNextPage=false` and
query explicit `parent { id identifier }`. After terminal state it captures the
id/updated-at set twice and requires stability. Manifest ids are reconciled in
both directions with browser captures, Conductor's durable projection mapping,
and the resource ledger. Review coverage must be exactly 100 percent, and every
required fragment must map to exactly one review unit. Missing, duplicated,
orphaned, unstable, or unreviewed ids fail with
`linear_customer_experience_coverage_incomplete`.

#### Deterministic Hard Checks

Deterministic checks collect all findings before model judgment and remain the
authority for:

- API pagination completion, terminal capture stability, browser expansion,
  manifest equality, and one browser capture per required artifact;
- exact parent/child topology, `blocks` relations, states, labels, and durable
  projection ids;
- exact `attempt_id -> comment_id` and wait-identity -> instruction-update
  mappings;
- absence of duplicate issues/comments, stale superseded instructions,
  per-line backend chatter, and unapproved links;
- absence of secrets, credentials, local credential paths, raw internal
  tracebacks, or unsanitized backend payloads;
- consistency between durable state, API data, and browser-visible content;
- presence of a sanitized reason, responsible actor, exact next action, resume
  condition, and expected outcome on every blocked/waiting/failure artifact;
- correct separation of managed human waits and runtime wait resume channels;
- explicit diagnostic/negative-control intent;
- preservation of the customer's original business request.

Leak checks run before reviewer input is assembled. A detected secret is
replaced with `[REDACTED]` in all reviewer material and fails the hard gate; the
secret value itself is neither sent to the reviewer nor archived. The reviewer
agent and human adjudication cannot override a failed deterministic check.

#### Customer-Value Rubric

The reviewer scores every issue and comment review unit on each of eight
mandatory dimensions from 0 to 4:

| Dimension | Question |
|---|---|
| Meaning | Can a customer immediately understand why this artifact exists and what it says? |
| Customer value | Does it help the customer make progress, understand progress, or trust the result? |
| Clarity | Is the important information scannable without decoding internal terminology or excessive detail? |
| Actionability | Is the customer's exact action and expected outcome obvious, or is it explicit that no action is required? |
| Intuitiveness | Can a customer predict what the artifact means and what will happen next without product-internal knowledge? |
| Usability | Do title, state, hierarchy, relations, and links make the workflow efficient and easy to navigate? |
| Correctness and trustworthiness | Is the visible explanation factually consistent, non-misleading, and appropriately qualified? |
| Safety and privacy | Are instructions safe and are sensitive or internal details absent without hiding useful failure meaning? |

A versioned `ArtifactKindRubric` adapts each question to artifact kind and
origin but cannot omit a dimension. For progress or completion output with no
customer action, actionability means clearly stating that no action is required
and what Symphony will do next or what terminal state was reached. Repetition,
low-value chatter, and backend noise remain deterministic hard checks and also
inform clarity, value, and usability scores.

The whole journey is also scored on customer-facing tone and terminology,
completion usefulness, cross-artifact coherence, and scenario realism. The
fixture fails realism if it reads like a test prompt rather than plausible
customer work.

Score meanings are:

- `0`: harmful, incorrect, misleading, or unusable;
- `1`: mostly internal, confusing, or missing its customer purpose;
- `2`: understandable but noisy, incomplete, weakly actionable, or difficult to
  navigate;
- `3`: meaningful, clear, actionable, and usable with only non-blocking polish
  concerns;
- `4`: concise, polished, immediately useful, and exemplary for the scenario.

The customer-experience gate passes only when:

- deterministic hard checks pass;
- review coverage is 100 percent;
- every review unit scores at least 3 on all eight dimensions under its
  origin-aware artifact rubric;
- the final parent summary scores at least 3 on all eight dimensions;
- all four journey-level scores are at least 3;
- there is no critical finding and no major correctness or safety finding.

Scores are never averaged; one low required dimension fails the gate. The
experience score is distinct from the `AGENT.md` evidence-based acceptance
score, although a failed experience gate prevents the related requirement from
receiving `4/4` acceptance.

A semantic score below 3 fails with
`linear_customer_experience_gate_failed`. The schema-validated result records
the scenario and commit, artifact-manifest hash, reviewer profile/model/config,
rubric and prompt revisions, expected/reviewed/missing/duplicate ids,
per-artifact scores, evidence-backed findings, journey scores, and one verdict:
`passed`, `failed`, or `blocked`. Every finding identifies the artifact,
dimension, severity, quoted visible evidence, browser capture, concrete reason,
and suggested customer-facing rewrite. The reviewer returns all findings; it
does not stop at the first low score.

The minimum result shape is:

```json
{
  "schema_version": 1,
  "scenario_id": "customer_onboarding_to_completed_managed_run",
  "commit_sha": "...",
  "artifact_manifest_sha256": "...",
  "reviewer": {"profile": "...", "model": "...", "config_sha256": "...", "run_id": "..."},
  "coverage": {"expected_ids": [], "reviewed_ids": [], "missing_ids": [], "duplicate_ids": [], "percent": 100},
  "artifact_reviews": [{"review_unit_id": "...", "fragment_ids": [], "scores": {}, "findings": []}],
  "journey_review": {"scores": {}, "findings": []},
  "verdict": "passed"
}
```

Schema validation requires each expected fragment id exactly once, all eight
scores for every review unit in the integer range 0-4, and evidence references
for every finding.

If the reviewer cannot load all artifacts, returns invalid structured output,
or becomes unavailable, the experience gate is `blocked`, never passed. The
evidence bundle records reviewer model/config, rubric revision, prompt hash,
exact sanitized input/output hashes, artifact manifest, per-artifact results,
browser/version/viewport/locale/timezone, screenshots or accessible-text
captures, build digest, and any adjudication.

When all artifacts do not fit one model context, issue review units are
partitioned deterministically by issue and reviewed in parallel; an issue and
all of its comments stay in one partition. A final pass receives only the
structured partition results plus root and terminal artifacts and scores global
coherence. The coverage validator forbids truncation and proves every unit was
reviewed exactly once.

Rerunning until a model happens to pass is prohibited. A human may adjudicate
only semantic findings, one artifact and rubric rule at a time, with a recorded
reason; coverage, hard checks, and secret findings cannot be overridden. Rubric,
prompt, or model upgrades must pass fixed good/bad calibration fixtures before
they can evaluate a release candidate.

### Focused Scenario Catalog

| Scenario or parameterized family | Primary customer fact or protected risk | Minimum level and real-boundary use | Decisive fault |
|---|---|---|---|
| `workspace_account_access` | Registration, returning sign-in, and logout each produce their own correct session outcome | Contract; real browser when auth is affected; one result per operation | Expired or invalid session case |
| `customer_owned_app_activation` | A customer-owned app can become the first healthy active installation | Integration + real browser/OAuth/Linear | Invalid first candidate |
| `oauth_candidate_cutover` | A failed replacement cannot replace active; a valid candidate switches only after drain and runtime ack | Integration + real browser/OAuth/Linear/Conductor | Invalid or delayed candidate |
| `linear_installation_reconnect` | Reauthorization restores one unhealthy installation without changing identity silently | Integration + real browser/Linear | Broken token |
| `linear_installation_revoke` | Revocation retires one installation and disables its routing | Integration + real browser/Linear | No injected fault |
| `project_deselection` | Deselect removes Symphony scope without mutating Linear membership | Contract + selected real browser/Linear check | Bound or inaccessible project case |
| `delegated_issue_to_verified_delivery` | Daily delegated work produces one verified, observable result without repeating onboarding | Deterministic system; canonical journey supplies full live proof | No injected fault |
| `managed_run_observability` | Active, blocked, failed, and done runs explain state, evidence, and next action | System snapshots plus reviewer; selected real Linear/Podium captures | One visible blocked or failed state |
| `webhook_recovery_dedupe` | A missed webhook is recovered without a duplicate dispatch | Integration + real Linear/Podium; no source-changing Codex turn | Suppress one delivery |
| `routing_guards` | Wrong org/project/app user, blockers, capacity, or duplicate binding cannot route | Deterministic contract/system plus selected boundary checks | One ineligible input per separately reported case |
| `deferred_dispatch_recovery` | Work rejected for a temporary blocker or capacity starts exactly once after recovery | Deterministic system; selected real Linear/Podium | Release one temporary blocker |
| `linear_dependency_ingestion` | A customer-added `blocks` edge is unioned, validated, and changes readiness | Integration; real Linear when projection/ingestion changes | One invalid edge case |
| `plan_approval` | A plan waits and resumes only on its recorded root state flip | Integration + real Linear | One approval wait |
| `work_item_approval` | One gated work item remains ineligible until its recorded child approval event | Integration + real Linear | One work-item approval gate |
| `managed_information_wait` | A blocked run or work item gives a useful instruction and resumes only on its state flip | Integration + real Linear | One missing-information wait |
| `runtime_wait` | Runtime approval/tool input creates one Human Action child and resumes only through it | Real process + Linear projection with deterministic wait probe | One runtime wait |
| `attempt_retry_restart` | Crash/timeout uses a fresh lease/fence and resumes durable state | Deterministic system with real processes | One process crash or timeout |
| `verification_rework` | Independent verification failure preserves evidence and later corrected work can pass | Deterministic system with real verifier | One fail-once verification |
| `plan_revision` | Approved scope/dependency change creates immutable v2 and preserves v1 | Deterministic system + selected real operator projection | One revision request |
| `parallel_clean_join` | Safe parallel work publishes verified manifests and joins before downstream work | Deterministic system with real processes | No injected fault |
| `integration_conflict_resolution` | A conflict becomes actionable and explicit resolution reaches a final delivery | Deterministic conflict + selected real Linear action flow | One controlled conflict |
| `runtime_same_host_isolation` | A second project runtime cannot collide with the first | Affected platform live | No injected fault |
| `runtime_rename`, `runtime_replacement`, `runtime_unbind`, `runtime_rebind` | Each runtime ownership operation preserves or deliberately transfers routing | Affected platform live; each operation is a separate result | One operation failure where applicable |
| `runtime_update`, `runtime_rollback` | Update reaches a healthy target; failed update can restore the prior healthy version | Affected platform live; separate operation results | One failed health check for rollback |
| `runtime_credential_rotation`, `runtime_routing_suspension`, `runtime_routing_resume`, `runtime_log_audit_access` | Each security/operator action remains scoped, auditable, and actionable | Integration + affected platform; separate operation results | Expired credential or denied operation where applicable |

Every executable entry stores its business mapping in
`AcceptanceScenarioSpec.business_scenarios`. The required mapping is:

| Acceptance scenario(s) | Business scenario ids |
|---|---|
| `workspace_account_access` | B01a, B01b, B01c as separately reported operations |
| `customer_owned_app_activation`, `oauth_candidate_cutover` | B03 and B04 respectively |
| `linear_installation_reconnect`, `linear_installation_revoke` | B05a and B05b respectively |
| `project_deselection` | B06b; B06a is canonical-only |
| `delegated_issue_to_verified_delivery` | B13 |
| `managed_run_observability` | B14 |
| `webhook_recovery_dedupe` | B13, B14 |
| `routing_guards`, `deferred_dispatch_recovery` | B08/B15 and B15 respectively |
| `linear_dependency_ingestion` | B16 |
| `plan_approval`, `work_item_approval`, `managed_information_wait`, `runtime_wait` | B17a, B17b, B18, B19 respectively |
| `attempt_retry_restart`, `parallel_clean_join` | B13/B14 and B13 respectively |
| `verification_rework`, `plan_revision`, `integration_conflict_resolution` | B21/B14, B20/B14, and B22/B14 respectively |
| `runtime_same_host_isolation` | B09 |
| `runtime_rename`, `runtime_replacement`, `runtime_unbind`, `runtime_rebind` | B10a, B10b, B10c, B10d respectively |
| `runtime_update`, `runtime_rollback` | B11a and B11b respectively |
| `runtime_credential_rotation`, `runtime_routing_suspension`, `runtime_routing_resume`, `runtime_log_audit_access` | B12a, B12b, B12c, B12d respectively |

B01a/B01c, B02, B06a, and B07 are intentionally proved by the canonical
journey. B08, B13, and B14 have both canonical and focused proof. Catalog
validation fails any
technical scenario that lacks a business mapping and customer-risk statement.

Clean join and integration conflict are separate scenarios because their
expected terminal results are mutually exclusive. Retry, rework, and plan
revision are separate because they have different state semantics. Plan
approval, work-item approval, managed information waits, and runtime waits are
separate because they have different intent and resume channels. A
parameterized family emits a separate scenario result per operation or fault;
it is not one multi-fault run.

The canonical journey always uses real Codex. Focused fault scenarios use real
Codex only when Codex behavior is the fact under test. Deterministic fault
injection is required when a random external failure would make the verdict
non-reproducible.

### Change Risk And Execution Policy

Every pull request and release candidate produces one machine-readable
`ChangeImpactDecision` before scenario selection. It is bound to the exact
commit, build digest, classifier revision, configuration digest, changed paths,
declared capabilities, risk class, core triggers, size signals, affected
business scenarios, selected acceptance scenarios, skipped scenarios with
reasons, and whether the canonical journey is required. A later relevant code
or configuration change invalidates the decision and its live evidence.

Pull-request classification uses that pull request's merge diff. Release-
candidate classification is recomputed over the cumulative diff from the last
accepted production baseline, so splitting a major change across several small
pull requests cannot avoid the canonical journey. A changed production path
without a registered capability and business-scenario mapping makes impact
selection `blocked`; unknown paths never default to `localized`.

```json
{
  "schema_version": 1,
  "commit_sha": "...",
  "baseline_sha": "...",
  "build_digest": "...",
  "classifier_revision": "...",
  "risk_class": "core",
  "core_triggers": [],
  "size_signals": {},
  "affected_capabilities": [],
  "affected_business_scenarios": [],
  "selected_acceptance_scenarios": [],
  "not_evaluated": [],
  "canonical_journey_required": true,
  "decision_reasons": []
}
```

Risk classification uses the first matching precedence:
`core` > `major` > `localized`.

| Risk class | Non-negotiable triggers |
|---|---|
| `core` | Shared runtime contracts; auth/session/OAuth/installations; project selection, enrollment, binding, or config acknowledgement; webhook/reconciliation/routing/dispatch/lease/fencing; Managed Run transitions, planning, readiness, retry, rework, revision, gates, verification, integration, waits, or Linear projection; Performer turn/Codex/runtime-profile protocol; security, credential, sanitization, or acceptance oracle/evidence/reviewer behavior |
| `major` | Two or more runtime roles or business capabilities; public API/BFF contract plus consumers; durable schema or migration; replacement of a production composition path; or a broad executable change presumptively reaching 12 production files or 500 non-generated executable lines, excluding pure moves |
| `localized` | One non-core capability, stable public and persistence contracts, no customer-flow semantic change, and below the major breadth threshold |

Core classification is semantic, not proportional to diff size: a one-line
fencing, OAuth-state, resume-channel, or secret-redaction change is core. A
workflow or copy change in onboarding, Managed Runs, Linear issues/comments,
failure instructions, or the experience rubric is not cosmetic. The automatic
path/capability classifier and the author's declaration are unioned. Humans may
raise risk but cannot override or downgrade an objective `core` or `major`
trigger. A false-positive rule is corrected only by a reviewed, versioned
classifier change followed by recomputing the decision and invalidating prior
evidence.

The selected execution set is:

| Change impact | Mandatory acceptance | Canonical real journey |
|---|---|---|
| `core` | Affected unit/contract/integration/system tests; every affected focused scenario at its declared minimum level and real boundary; all shared boundary contracts | Required from clean resources, including the Linear experience reviewer |
| `major` | Affected deterministic tests plus all impacted capability and cross-role scenarios, run in parallel where isolation permits | Required from clean resources, including the Linear experience reviewer |
| `localized` | Affected deterministic tests; an affected focused live scenario when the changed fact depends on a real external or customer-visible boundary | On demand, selected explicitly by impact analysis or operator request |
| Runtime-platform impact | The relevant same-host, identity, binding, update/rollback, or security operation on every affected service-manager platform | Also required only when the overall change is `core` or `major`, otherwise on demand |

Skipping the canonical journey is therefore allowed only for a recorded
`localized` decision. It cannot be silent: the report records
`not_evaluated`, the non-triggering reasons, affected business scenarios, and
the focused evidence that was run instead. An operator can always promote any
change to canonical acceptance.

All affected deterministic branches run before expensive live work. Independent
preflights and scenarios execute in parallel within isolated accounts,
projects, repositories, ports, databases, and credential roots. A failed branch
blocks only its dependents; other branches continue and contribute their
failures to the same report. Development reruns target failed/blocked branches,
while the final gate reruns the full risk-selected set from clean resources.

Before G5 legacy retirement, G4 is a one-time migration parity gate and runs
every catalog row regardless of its future routine trigger. After G5, normal
release candidates use this risk policy rather than rerunning all live journeys.

### Acceptance Fact Matrix

The business catalog answers what customers do. This matrix answers what facts
must be proved and at what cost. G4 executes all rows once before legacy
retirement; routine runs follow the trigger column.

| Acceptance fact | Minimum test level | Acceptance scenario | Routine trigger | Authority and operator oracle | Required evidence |
|---|---|---|---|---|---|
| Registration creates a usable authenticated workspace | Contract + live browser | Canonical journey | Core/major/manual | Podium session authority + browser | Registration response, cookie, sanitized bootstrap |
| Returning sign-in restores a valid session | Contract + selected live browser | `workspace_account_access` | Auth affected/manual | Podium session authority + browser | Login response, cookie, sanitized bootstrap |
| Logout invalidates the current session | Contract + live browser | Canonical journey | Core/major/manual | Podium session authority + browser | Logout response, cookie invalidation, protected rejection |
| Default-app OAuth state and callback acceptance | Contract + live | Canonical journey | Core/major/manual | Podium installation + browser/Linear | State consumption, actor, scopes, org, app user, token health |
| First customer-owned application activation | Integration + live | `customer_owned_app_activation` | Installation capability affected/manual | Podium installation + browser/Linear | Candidate validation, callback, active generation, health |
| Candidate failure and atomic application replacement | Integration + live | `oauth_candidate_cutover` | Installation or cutover affected/manual | Podium installation + browser/runtime health | Active/candidate generations, drain, config ack, cutover/retire |
| Installation reconnect restores explicit healthy state | Integration + selected live | `linear_installation_reconnect` | Installation lifecycle affected/manual | Podium installation + browser/Linear | Prior reason, reauthorization, identity and health |
| Installation revoke retires access and routing | Integration + selected live | `linear_installation_revoke` | Installation lifecycle affected/manual | Podium installation + browser/Linear | Revocation, retired generation, routing state |
| Project selection enables scope without mutating membership | Contract + live | Canonical journey | Core/major/manual | Podium topology + Linear project | Selected state, read/write proof, membership audit |
| Project deselection removes scope without mutating membership | Contract + selected live | `project_deselection` | Project scope affected/manual | Podium topology + Linear project | Deselected/routing state, membership audit |
| Named enrollment is single-use, isolated, online, and initially unbound | Integration + live | Canonical journey | Core/major/manual | Podium topology + runtime presence | Enrollment record, install command, service/data-root identity |
| Project/repository binding is unique and acknowledged | System + live | Canonical journey, `routing_guards` | Binding affected; canonical on core/major/manual | Podium desired binding + Conductor acknowledged config | Binding ids, rejected duplicates, repo health, label |
| Onboarding smoke reflects real dependency health | Integration + live | Canonical journey | Core/major/manual | Capability health authorities + browser | Installation/project/runtime/repo/proxy/webhook results |
| Same-host runtimes remain isolated | Affected platform live | `runtime_same_host_isolation` | Runtime layout/platform affected | Podium topology + Conductor services | Runtime ids, service/data roots, ports, credentials, labels |
| Runtime rename preserves identity, health, and label parity | Affected platform live | `runtime_rename` | Rename/label affected | Podium topology + Conductor service + Linear label | Prior/new name, runtime id, health, label |
| Runtime replacement transfers ownership only after drain | Affected platform live | `runtime_replacement` | Replacement affected | Podium topology + Conductor services + Linear label | Drain, prior/new runtime and binding, label |
| Runtime unbind disables routing and removes ownership | Affected platform live | `runtime_unbind` | Unbind affected | Podium topology + Conductor service + Linear label | Drain, cleared config, routing disable, label removal |
| Runtime rebind creates one acknowledged routing-ready owner | Affected platform live | `runtime_rebind` | Rebind affected | Podium topology + Conductor service + Linear label | Reservation, config ack, repository health, label |
| Runtime update reaches one healthy target version | Affected platform live | `runtime_update` | Update/service-manager affected | Podium runtime operations + service health | Target/checksum/restart/health evidence |
| Runtime rollback restores the prior healthy version | Affected platform live | `runtime_rollback` | Rollback/service-manager affected | Podium runtime operations + service health | Failed health, prior target, restart, restored health |
| Runtime credential rotation revokes old access and preserves scoped health | Integration + affected platform | `runtime_credential_rotation` | Runtime credential/security affected | Podium security authority + runtime | Old revocation, new health, sanitized audit event |
| Routing suspension drains and prevents new dispatch | Integration + affected platform | `runtime_routing_suspension` | Routing control affected | Podium routing authority + runtime | Drain, disabled state, no new lease |
| Routing resume restores dispatch only after health checks | Integration + affected platform | `runtime_routing_resume` | Routing control affected | Podium routing authority + runtime | Health/config checks, enabled state, eligible lease |
| Runtime logs and audit are scoped, sanitized, and useful | Integration + affected platform | `runtime_log_audit_access` | Log/audit surface affected | Podium audit/log authority + runtime | Scoped events, correlation ids, leak scan, next action |
| Signed webhook happy-path intake queues exactly one dispatch | Contract + live | Canonical journey | Core/major/manual | Podium intake/dispatch + Linear delivery | Signature/timestamp/delivery id, normalized event, dispatch |
| Reconciliation recovers a missed webhook without duplication | Integration + selected live | `webhook_recovery_dedupe` | Intake/reconciliation affected/manual | Podium intake/dispatch | Suppressed delivery, cursor, idempotency key, one dispatch |
| Organization/project/app-user/blocker/capacity guards fail closed visibly | Contract + system | `routing_guards` | Routing affected | Podium routing authority | One explicit skip reason per ineligible input |
| Temporary blocker or capacity release starts exactly one run | System + selected live | `deferred_dispatch_recovery` | Routing/readiness/capacity affected | Podium routing + Conductor run mapping | Before/after eligibility, dispatch/run ids, no duplicate |
| Queue, lease, fencing, heartbeat, ack, expiry, and reclaim are coherent | Contract + system + live | Canonical journey, `attempt_retry_restart` | Dispatch/attempt affected; canonical on core/major/manual | Podium dispatch + Conductor attempt | Lease/fence ids, heartbeats, reclaim, ack, ownership |
| One delegated parent maps to one durable Managed Run and verified delivery | Unit + system + live | `delegated_issue_to_verified_delivery`, canonical journey | Managed delivery affected; canonical on core/major/manual | Conductor Managed Run + Podium/Linear/repository | Run/parent ids, durable state, verification, repository result |
| Active, blocked, failed, and completed delivery is understandable in Podium and Linear | Contract + system + selected live browser/reviewer | `managed_run_observability`, canonical journey | Managed Runs view/projection/error copy affected; canonical on core/major/manual | Conductor state + Podium Managed Runs + Linear | State/evidence/next-action parity, browser captures, reviewer findings |
| Plans are valid, immutable, dependency-ready, and safely parallelizable | Unit + system + live | Canonical journey, `plan_revision`, `parallel_clean_join` | Planning/readiness affected; canonical on core/major/manual | Conductor Managed Run | Plan versions, graph, gates, readiness and overlap decisions |
| Human-added Linear dependencies are unioned and validated | Integration + selected live | `linear_dependency_ingestion` | Dependency ingestion/projection affected | Conductor plan authority + Linear | Before/after graph, explicit parent/relations, readiness |
| Safe parallel execution produces a verified clean join | System | `parallel_clean_join` | Parallel execution/integration affected | Conductor Managed Run/integration | Overlap windows, manifests, join commit, downstream start |
| Crash/timeout retry uses a fresh lease and resumes durable work | System | `attempt_retry_restart` | Lease/retry/process recovery affected | Podium lease + Conductor attempt | Old/new lease and fence, durable cursor, stale rejection |
| Failed independent verification produces visible, preserved rework | System + selected Linear review | `verification_rework` | Verification/rework affected | Conductor verification + Linear/Podium | Frozen gate, fail-once evidence, retry history, later pass |
| Approved revision creates immutable v2 and reconciles the issue tree | System + selected Linear review | `plan_revision` | Revision semantics/projection affected | Conductor Managed Run + Linear operator event | Approval, isolated plan turn, versions, child reconciliation |
| Plan approval resumes only through the recorded root state flip | Integration + live Linear | `plan_approval` | Approval/wait/projection affected | Conductor managed wait + Linear root | Wait identity, instruction, negative comment probe, state flip |
| Work-item approval makes only the recorded child eligible | Integration + live Linear | `work_item_approval` | Work-item gate/wait/projection affected | Conductor gate/wait + Linear child | Gate identity, child instruction/state flip, readiness decision |
| Missing-information wait resumes only through the affected issue state flip | Integration + live Linear | `managed_information_wait` | Managed wait/projection affected | Conductor managed wait + Linear issue | Reason/action/outcome, negative probe, state flip, resume |
| Runtime wait resumes only through its Human Action child | Integration + live Linear/process | `runtime_wait` | Runtime wait/projection affected | Conductor runtime wait + Linear child | Attempt/lease/wait ids, child, negative controls, resume |
| Integration conflict is visible, never silently merged, and can resolve to delivery | System + selected live operator flow | `integration_conflict_resolution` | Join/conflict/resolver affected | Conductor integration + Linear/Podium | Conflicting manifests, action record, resolution, final result |
| Every Linear issue/comment is meaningful, valuable, clear, actionable, intuitive, correct, low-noise, and safe | Live browser + deterministic checks + agent review | Canonical journey; applicable focused Linear scenarios | Canonical on core/major/manual; focused when selected | Durable projection + API/browser manifest + independent reviewer | 100% fragment coverage, captures, per-unit scores/findings, verdict |
| Podium, Linear, logs, and durable state remain in parity | Contract + system + selected live | Every selected scenario | Every selected scenario | Owning aggregate + derived operator surfaces | Versioned snapshot slices and correlation ids |
| Runtime credentials are isolated and all outputs are secret-free | Contract + live | Canonical journey and affected security scenarios | Core/major/manual or security affected | Conductor materialization + leak oracle | Staged seed provenance, isolated homes, leak scan, scrub report |
| Required evidence is complete before cleanup | System + live | Every selected live scenario | Every selected live scenario | Acceptance evidence manifest | Required hashes, failure fields, linked logs and reviewer evidence |
| Every created resource is cleaned idempotently | System + live | Every selected live scenario | Every selected live scenario | Resource ledger + external authorities | Cleanup-before/after and retained diagnostics |

### Current Runner Disposition

| Current execution mode or probe | Target disposition |
|---|---|
| `basic` | Split into repeatable system `delegated_issue_to_verified_delivery` and the risk-selected canonical journey |
| `parallel` | Replaced by deterministic system `parallel_clean_join` |
| `replan` | Split into `verification_rework` and `plan_revision` because their transitions differ |
| `integration-conflict` | Replaced by `integration_conflict_resolution`, which proves both visible action and eventual resolution |
| generic managed-wait flags | Split into `plan_approval`, `work_item_approval`, and `managed_information_wait` |
| combined runtime lifecycle mode | Split by same-host isolation, rename, replacement, binding, update/rollback, and security operation |
| `runtime-wait` | Replaced by focused live-operator `runtime_wait` |
| `gate-normalization` | Moved to contract tests plus verification system coverage |
| `overall-dod` | Removed as an execution mode; release report aggregation consumes independent scenario results |
| permission/crash/config flags | Become named scenario faults or preflight probes, never implicit flag combinations |
| Codex connectivity/overload probes | Remain classified backend probes and do not count as customer-journey E2E |

## Acceptance Runner Structure

```text
tools/symphony_acceptance/
  __main__.py
  cli.py
  registry.py
  catalog/
    business.py
    acceptance.py
    journeys.py
  impact/
    models.py
    classifier.py
    selector.py
  core/
    models.py
    scenario.py
    lifecycle.py
    clock.py
  actors/
    browser.py
    read_only_linear_browser.py
    linear_admin.py
    podium.py
    runtime.py
  clients/
    podium.py
    conductor.py
    linear.py
  fixtures/
    business.py
    repository.py
    linear_project.py
    codex_seed.py
  faults/
    webhook.py
    performer.py
    verifier.py
    integration.py
  observation/
    collectors.py
    snapshot.py
    linear_artifacts.py
    convergence.py
    stalls.py
  oracles/
    installation.py
    topology.py
    dispatch.py
    managed_runs.py
    projection.py
    security.py
  review/
    linear_experience.py
    rubric.py
    schema.py
    calibration.py
  evidence/
    writer.py
    sanitizer.py
    manifest.py
    bundle.py
  resources/
    ledger.py
    cleanup.py
    processes.py
    postgres.py
  scenarios/
    customer_onboarding_to_completed_managed_run.py
    workspace_account_access.py
    customer_owned_app_activation.py
    linear_installation_reconnect.py
    linear_installation_revoke.py
    project_deselection.py
    delegated_issue_to_verified_delivery.py
    managed_run_observability.py
    webhook_recovery_dedupe.py
    oauth_candidate_cutover.py
    routing_guards.py
    deferred_dispatch_recovery.py
    linear_dependency_ingestion.py
    plan_approval.py
    work_item_approval.py
    managed_information_wait.py
    runtime_wait.py
    attempt_retry_restart.py
    verification_rework.py
    plan_revision.py
    parallel_clean_join.py
    integration_conflict_resolution.py
    runtime_same_host_isolation.py
    runtime_rename.py
    runtime_replacement.py
    runtime_unbind.py
    runtime_rebind.py
    runtime_update.py
    runtime_rollback.py
    runtime_credential_rotation.py
    runtime_routing_suspension.py
    runtime_routing_resume.py
    runtime_log_audit_access.py
```

### Versioned Snapshot Envelope And Capability Slices

Observers do not compete on one monolithic snapshot schema. They emit
independently versioned capability slices inside a small stable envelope:

```python
@dataclass(frozen=True)
class SystemSnapshot:
    schema_version: int
    scenario_id: str
    captured_at: str
    correlation: CorrelationIds
    slices: Mapping[str, SnapshotSlice]
```

Initial slices are:

- `InstallationSnapshot`: installation, actor/scope, project-access, and token
  health without secrets;
- `TopologySnapshot`: desired binding, acknowledged config, repository health,
  runtime presence, and capacity;
- `DispatchSnapshot`: normalized intake, idempotency, queue, lease, fencing,
  heartbeat, and acknowledgement;
- `ManagedRunSnapshot`: plans, work items, attempts, waits, gates, manifests,
  and integrations;
- `ProjectionSnapshot`: Podium views, the fully paginated Linear
  tree/relations/comments/states and version history, durable projection maps,
  browser capture references, and correlated log events;
- `LinearExperienceSnapshot`: artifact fragments, review units, coverage and
  stability results, deterministic findings, reviewer scores/findings, and any
  adjudication;
- `RepositorySnapshot`: commit, tree, changed-file, and executed-test evidence;
- `EvidenceSnapshot`: change-impact decision, required artifacts, reviewer
  input/output/config hashes, leak scan, resources, and cleanup state.

Each oracle declares only the slice versions it consumes. A capability team can
add or revise its slice without editing unrelated scenario schemas. The common
envelope changes only for cross-cutting correlation or serialization needs.

Raw database and filesystem reads are diagnostic attachments, not the primary
acceptance oracle when an operator API is expected to expose the same truth.

### Evidence

The evidence subsystem provides:

- append-only check and lifecycle events;
- one sanitizer for key- and value-based secret patterns;
- recursive key-, value-, content-, and path-based leak scans over every
  candidate artifact and the finalized bundle, including browser/API captures,
  request/result JSON, manifests, reviewer input/output, logs, reports, and
  cleanup snapshots;
- required versus optional artifact declarations;
- hashes and sizes for every archived artifact;
- the exact `ChangeImpactDecision` and code/build/configuration digests that
  selected the suite;
- Linear artifact manifests, browser/API captures, deterministic experience
  findings, reviewer input/output/config, calibration revision, and
  adjudication records when the experience gate applies;
- stable failure fields: `error_type`, `error_code`, `sanitized_reason`,
  `action_required`, `retryable`, `attempt_number`, and `next_action`;
- per-requirement 0-4 acceptance scores that follow `AGENT.md` hard caps;
- an atomic final summary assembled from append-only events.

Missing required artifacts fail finalization. A failure count without linked
runtime logs is never a complete report.

### Resource Ledger And Cleanup

Every created resource is registered at creation time:

- Linear issue, relation, comment, label, and installation candidate;
- selected project state and binding;
- enrollment token and runtime;
- repository and worktree;
- PostgreSQL database/container;
- Podium, Conductor, Performer, and tunnel processes;
- staged Codex seed and per-role credential copies.

Cleanup is idempotent and reverse-order. Diagnostic candidates are collected
before destructive cleanup, but evidence discovery excludes credential roots,
seed contents, `auth.json`, and any directory that contains it. After dependent
processes stop, credential copies are scrubbed before final bundle assembly.
Cleanup-before/after snapshots are then added, and the complete bundle is
rescanned before archival. A leak or excluded-root traversal fails finalization.

## Parallel Implementation Workflow

Parallel delivery is a design requirement, not an optimization left to the
implementer.

### Dependency Graph

```text
F0: approve this design and inventory concepts
  |
  +--> F1: stable ids, error/event envelope, and transition CAS
  |       |
  |       +--> P1/P2/P3: Podium capability slices --------+
  |       +--> C0: Conductor aggregate/UoW foundation      |
  |       |       +--> C1/C2: Conductor capability slices -+--> G1
  |       +--> W: Performer one-turn cleanup --------------+    |
  |       +--> U*: Web feature slices ---------------------+    |
  |                                                         |    v
  +--> F2: business/scenario catalogs, impact policy,       |  local
          snapshot envelope, and review schema              |
          |                                                  |  system gate
          +--> H*: acceptance-tooling capability slices ----+    |
          +--> S*: focused scenarios after their slices ---------+
          +--> R*: Linear capture/reviewer/calibration ----------+
                                                                 |
                                                                 v
                                                G2: local acceptance matrix
                                                                 |
                                  +------------------------------+------------------+
                                  v                                                 v
              G3: required customer journey live                affected focused live boundaries
                                  +------------------------------+------------------+
                                                                 v
                                           G4: one-time migration parity
                                                                 |
                                                                 v
                                                G5: retire legacy paths
```

`F0`, the minimal cross-role envelope in `F1`, the Conductor transition/CAS
foundation `C0`, and the snapshot envelope in `F2` are sequential. Capability
contracts and snapshot slices are then stabilized one vertical slice at a time;
the design does not wait for a repository-wide contract freeze before useful
parallel work begins.

### Workstreams And File Ownership

| Workstream | Exclusive primary ownership | May coordinate on |
|---|---|---|
| Contract steward (`F1`) | Minimal cross-role ids/envelopes and one capability contract at a time | The producer and consumers of that contract only |
| Podium installation (`P1`) | `auth/`, `installations/`, their adapters/tests, and assigned legacy source files | Browser schemas and installation snapshot |
| Podium topology (`P2`) | `onboarding/`, `bindings/`, `runtime_ops/`, their adapters/tests, and assigned legacy source files | Conductor config acknowledgement |
| Podium intake (`P3`) | `intake/`, `dispatch/`, `linear_proxy/`, their adapters/tests, and assigned legacy source files | Conductor lease client and dispatch snapshot |
| Conductor state core (`C0`) | Managed Run aggregate, transitions, CAS repository, and outbox contract | Short sequential foundation for dependent Conductor slices |
| Conductor execution (`C1`) | Planning, execution, verification, integration, runtime process adapters, and assigned legacy files | Performer turn contract and repository handoff |
| Conductor projection (`C2`) | Waits, Linear projection/ingestion, Podium reporting, and assigned legacy files | Managed Run events and projection snapshot |
| Performer (`W`) | `packages/performer/src/performer/`, Performer tests | Turn contracts, Codex adapter |
| Web (`U*`) | One `packages/podium/web/src/features/<capability>/` slice per work item | Its sanitized BFF schema only |
| Acceptance core (`H*`) | One actor/client, snapshot slice, oracle family, evidence, or resource capability per work item | Public role APIs and snapshot envelope |
| Acceptance scenarios (`S*`) | One named scenario, fixture, and fault profile per work item | Only the snapshot slices/oracles declared by that scenario |
| Linear experience (`R*`) | Read-only browser capture, artifact manifest, hard checks, rubric/schema, calibration, and reviewer adapter | Projection snapshot and evidence bundle only |
| Integration steward | boundary tests, integration manifests, final docs | Merge gates; does not own role internals |

No two active work items own the same production or migration-source file. The
implementation plan contains an ownership ledger for both target paths and the
existing flat modules being migrated. Shared contract changes are proposed and
landed by the contract steward before dependent role changes. If a workstream
discovers a missing contract, it pauses only that dependent slice, submits a
narrow contract change, and continues independent tasks.

### Parallelization Rules

Safe to run in parallel after the foundation gate:

- Podium installation, topology, and intake slices when their assigned legacy
  files and capability repositories do not overlap;
- Conductor execution and projection slices after `C0` publishes stable
  transition events and repository semantics;
- Performer legacy audit/one-turn cleanup and acceptance evidence primitives;
- named focused scenarios after their actors, faults, snapshot, and oracle
  interfaces are stable;
- Linear capture/manifest work, reviewer schema/calibration work, and unrelated
  scenario work after their shared contracts are stable;
- frontend feature modules after sanitized BFF schemas are accepted;
- documentation and contract tests for already accepted interfaces.

Must remain sequential:

- a shared DTO change and its consumers before the DTO is accepted;
- central Managed Run transition policy and callers that depend on new
  transitions;
- a database migration and adapters that assume the migrated schema;
- snapshot envelope changes and all consumers; individual capability slice
  changes block only consumers of that slice;
- legacy-path deletion before the replacement production composition path has
  passed its integration gate;
- live `customer_onboarding_to_completed_managed_run` acceptance before
  webhook, binding, smoke, fixed business fixture, evidence, read-only Linear
  capture, reviewer calibration, and cleanup prerequisites are implemented.

Needs explicit coordination:

- changes spanning Podium dispatch payloads and Conductor lease handling;
- changes spanning Conductor turn requests and Performer results;
- BFF schemas and TypeScript models;
- project binding, label projection, and runtime config acknowledgement.

Scenario execution uses narrow, validated resource claims. A scenario may claim
only the Linear organization/project, Podium database, public origin, runtime
host/port, fixture repository, or credential root it actually mutates; a global
claim requires a concrete catalog reason. Conflicting claims serialize only
those branches.

The scheduler is work-conserving: while a compatible ready branch and a slot
exist, it starts that branch. The target default is four scenario branches and
may be reduced only by measured external capacity or the number of isolated
resource sets, with the reason recorded. When at least two compatible branches
and resources exist, lack of observed overlap fails the parallel-execution
check. Planned/actual overlap and resource waits are report evidence.

### Task Shape

After design approval, the implementation plan is written to `tasks/plan.md`
and `tasks/todo.md`. Every task:

- is one vertical capability slice;
- declares dependencies and exclusive file scope;
- includes RED and GREEN commands where behavior changes;
- includes acceptance criteria and a verification command;
- ends with the repository in a working state;
- identifies the integration gate that consumes it;
- fits a review-size budget, normally one focused session and roughly 3-7
  files, but preserves behavioral atomicity when a valid cross-boundary slice
  requires more files.

Tasks with more than one primary capability or overlapping file scope are split
before assignment. File count alone never forces a coherent transaction,
contract, migration, and test slice into separate non-working changes.

### Branches, Worktrees, And Integration Cadence

- Use short-lived branches/worktrees, one workstream per worktree.
- Merge contract/foundation changes first; rebase dependent streams promptly.
- Integrate every two or three completed tasks rather than accumulating a large
  role rewrite.
- Run focused tests in each workstream and the cross-role contract suite at
  every merge gate.
- Run the local system gate after each coherent vertical slice.
- Run live external acceptance only after deterministic prerequisites pass.
- A failed integration gate stops only dependent streams; unrelated streams
  continue.

### Integration Gates

**G0 - Design and inventory**

- capability and authority maps approved;
- current business scenarios, acceptance facts, and coverage gaps approved;
- duplicate candidates classified;
- baseline behavior and current gaps recorded;
- public interfaces that must remain stable identified;
- impact-classification and Linear-experience contracts approved.

**G1 - Contracts and local composition**

- shared contracts pass consumer/provider tests;
- each capability's JSON/PostgreSQL adapters pass that capability's repository
  and concurrency contract suite;
- internal import boundaries pass;
- no role imports another role;
- each migrated capability uses the production composition path.

**G2 - Local system acceptance**

- Podium, Conductor, and Performer complete deterministic happy and recovery
  paths locally;
- state, API, projection, and log parity pass;
- evidence and resource-ledger failure paths pass;
- impact selection, collect-all reporting, artifact coverage, reviewer schema,
  prompt-injection handling, good/bad calibration fixtures, minimal resource
  claims, and synthetic independent-branch overlap pass.

**G3 - Live `customer_onboarding_to_completed_managed_run` acceptance**

- the gate runs whenever the impact decision is `core` or `major`, when an
  operator selects it, and once unconditionally during this migration;
- the fixed business fixture passes through real
  browser/OAuth/Linear/webhook/Podium/Conductor/Performer/Codex boundaries;
- the Linear manifest is stable and complete, deterministic hard checks pass,
  every fragment is covered exactly once, every required semantic score is at
  least 3, and the independent reviewer verdict passes;
- required evidence, reviewer reproducibility data, and cleanup parity pass;
- no unresolved critical gaps remain.

**G4 - One-time complete migration parity**

- every current Business Scenario Catalog row maps to at least one passing
  acceptance scenario and every Acceptance Fact Matrix row has passing evidence
  at its required level, regardless of future routine trigger;
- the canonical customer journey and every focused scenario family have
  complete, separately causal reports;
- the new suite covers every mandatory fact previously claimed by the current
  real-run guide and acceptance appendix;
- the migration report links each business job and fact to its scenario,
  authority, operator oracle, artifacts, experience result where applicable,
  and cleanup result;
- no required fact is represented only by a source-string test or documentation
  assertion.

G4 is not the routine post-migration cadence. It is the proof required to retire
legacy paths; subsequent releases use the recorded change-risk policy.

**G5 - Legacy retirement**

- G4 one-time migration parity has passed;
- shadow services, unreachable legacy modules, wildcard facades, global
  monkeypatch forwarding, source-string tests, and `overall-dod` execution mode
  are removed;
- current product docs are updated only after the new architecture is real.

## Migration Sequence

### Phase 0: Baseline And Catalogs

1. Approve the capability and authority maps.
2. Inventory canonical, boundary, projection, adapter, and legacy definitions.
3. Record current API/CLI contracts and characterization tests.
4. Instantiate the executable business, acceptance-scenario, journey, and
   acceptance-fact catalogs; each current coverage gap remains explicit.
5. Define and baseline the machine-readable change-impact classifier against
   representative historical changes.

No production behavior changes in this phase.

### Phase 1: Contract And Acceptance-Tooling Foundations

1. Define structured transition, block, gate, wait, and minimal cross-role
   envelope contracts.
2. Add capability-scoped repository, concurrency, and internal import-boundary
   ports/tests.
3. Implement the snapshot envelope, capability slices, impact selector, and pure
   oracles with characterization tests.
4. Add evidence writer and resource ledger foundations.
5. Add read-only Linear capture, versioned artifact manifest, hard checks,
   reviewer schema/rubric, and calibration fixtures.

After the shared shapes are accepted, the role workstreams proceed in parallel.

### Phase 2: Parallel Role Capability Slices

- Podium: converge auth/installation/onboarding services, then topology,
  webhook/reconciliation intake, dispatch, smoke health, and background-job
  supervision.
- Conductor: introduce the Managed Run aggregate/transition owner, then migrate
  planning, execution, verification, integration, waits, projection, and
  Podium reporting one vertical slice at a time.
- Performer: confirm and remove unreachable legacy responsibilities, then
  organize the one-turn runner, protocol, and Codex backend.
- Web: align feature modules and closed DTO unions as each BFF capability
  stabilizes.
- Acceptance: build actors, clients, observers, impact selection, evidence,
  resources, experience review, and focused scenario modules against stable
  public interfaces.

### Phase 3: System And Live Journeys

1. Pass deterministic local system flows.
2. Implement the missing real customer-path prerequisites: supported OAuth
   journey, installer/enrollment/binding, signed webhook intake, real smoke
   health, complete evidence, and resource cleanup.
3. Pass canonical `customer_onboarding_to_completed_managed_run` with every
   real boundary, complete Linear artifact coverage, and a passing independent
   customer-experience review.
4. Pass every catalog scenario and record the one-time G4 migration parity
   report.

### Phase 4: Retirement And Documentation Cutover

1. Require recorded G4 migration parity before deleting any legacy
   acceptance path.
2. Remove `overall-dod` as an execution scenario; retain only suite-level report
   aggregation.
3. Remove the old runner facades and duplicated state/oracle logic.
4. Remove confirmed shadow/legacy production paths and their obsolete tests.
5. Rename/reclassify remaining tests by level.
6. Update `docs/product/`, `AGENT.md`, and the real-run guide to describe the
   implemented architecture, reviewer gate, and core/major/localized trigger
   policy. Until then the current real-run rules remain authoritative.

## Boundaries

### Always

- Preserve the four top-level import boundaries.
- State the authority and transition owner for every new stateful concept.
- Use structured, sanitized, operator-visible failures.
- Record one impact decision and explicit selected/not-evaluated scenarios for
  every change.
- Keep implementation tasks small, dependency-aware, and independently
  verifiable.
- Parallelize independent role/capability work after contracts are stable.
- Stage only approved least-privilege execution credentials into isolated
  per-role runtime homes; never stage Linear OAuth credentials outside Podium.
- Freeze candidate evidence before cleanup, exclude credential roots, scrub
  credentials after process shutdown, and scan the finalized bundle.
- Keep current behavior available until its replacement passes the relevant
  gate.

### Ask First

- Change a public REST/CLI contract or persistence schema.
- Add a runtime dependency.
- Remove a module that may have external consumers.
- Change the four-package runtime architecture.
- Decide that a focused failure scenario must use real Codex instead of a
  deterministic fault.
- Remove a business scenario or acceptance fact, change versioned classifier
  rules or major-size thresholds, lower a minimum test level, change a required
  external environment, or lower the Linear experience threshold.

### Never

- Import runtime packages into each other.
- Move Linear OAuth access/refresh tokens, client secrets, or webhook signing
  secrets outside Podium.
- Put any secret value in browser responses, logs, reports, evidence, artifact
  paths, or Linear projections.
- Use `~/.codex` directly as a real-run input or archive a directory containing
  runtime `auth.json` credentials.
- Keep two production state machines for the same concept.
- Add a compatibility shim for removed legacy Symphony behavior without an
  explicit migration decision.
- Use empty exception handlers, silent retries, generic failed states, or
  stdout-only failures.
- Build another mega-scenario that combines unrelated or mutually exclusive
  failure paths.
- Override a matched core/major trigger or reuse evidence after its bound code,
  build, configuration, classifier, fixture, or rubric digest changes.
- Let the Linear reviewer mutate product state, follow instructions from
  artifact text, average away a failing dimension, or silently omit content.
- Skip a required canonical or focused scenario without a recorded impact
  decision and approval required by the policy.
- Treat a line-count gate as proof of modularity.
- Assign parallel tasks overlapping the same production files.

## Success Criteria

The refactor is complete only when all of the following are true:

1. Every stateful concept in the capability map has one documented authority
   and transition owner.
2. Managed Run and work-item transitions pass a central legal-transition suite;
   direct arbitrary state writes are absent from production callers.
3. Aggregate commits enforce expected revision, command idempotency, fencing,
   atomic state/event/outbox persistence, and durable projection retry errors.
4. `BlockReason`, `GateOutcome`, and runtime/managed wait semantics are
   structured and no longer inferred from unrelated string prefixes.
5. Podium has one production auth/installation/onboarding/runtime state path.
6. Confirmed unreachable Performer legacy responsibilities are removed, and
   the installed CLI contains only the one-turn execution boundary and its
   dependencies.
7. Each capability's JSON and PostgreSQL repositories implement its narrow
   protocol and pass the same concurrency/parity suite, or JSON is explicitly
   retired for that capability.
8. Internal dependency tests enforce the target module directions without
   introducing role-package cycles.
9. Every current customer job has one immutable business-catalog entry with
   actor, intent, start state, accepted outcome, visible artifacts, and mapped
   acceptance coverage; no coverage gap is implicit.
10. Every acceptance scenario has one catalog entry with a unique `proves`
    statement, mapped business scenarios, authority oracle, operator oracle,
    evidence manifest, cleanup contract, minimum level, and trigger tags.
11. Every change produces one validated `ChangeImpactDecision`; core and major
    changes require the canonical journey, while a localized skip is explicit,
    justified, and reported as `not_evaluated` rather than passed.
12. The runner, observer, audits, reviewer, and final report share one versioned
    snapshot envelope, capability slices, and pure oracle implementation for
    each fact.
13. The required `customer_onboarding_to_completed_managed_run` journey passes
    its fixed business fixture through a real browser, OAuth, Linear, webhook,
    Podium, Conductor, Performer, and Codex.
14. The canonical journey's Linear manifest reconciles every issue, fragment,
    and comment version against API, browser, durable mappings, and the resource
    ledger with 100 percent coverage; all hard checks and required artifact and
    journey scores pass at 3 or higher.
15. Webhook recovery, OAuth lifecycle, project/runtime lifecycle, routing,
    waits, retry, rework, revision, dependency ingestion, parallel join, and
    conflict resolution have separately causal focused evidence at the mapped
    level and trigger.
16. The work-conserving scheduler overlaps compatible preflights and scenario
    branches up to validated resource capacity; one report returns every
    independently discoverable root cause with `passed`, `failed`, `blocked`,
    or `not_evaluated`, and no branch waits for a global timeout after a concrete
    failure is known.
17. Every failed live run archives Podium, Conductor, Performer, request/result,
    Managed Runs, Linear, reviewer, and cleanup evidence with a concrete
    sanitized reason.
18. Every external resource created by acceptance is registered and cleanup-
    before/after parity is verified.
19. Every Business Scenario Catalog and Acceptance Fact Matrix row passes the
    one-time G4 migration parity gate before legacy acceptance is retired.
20. `overall-dod`, wildcard runner facades, global collaborator swapping,
    source-string runner tests, and duplicated legacy payload normalization are
    removed only after G4 migration parity.
21. Implementation work is delivered through capability-level parallel
    workstreams with exclusive file ownership and behaviorally atomic,
    reviewable tasks; file count alone does not define a module or task.
22. A representative single-capability requirement no longer requires edits
    across unrelated route, store, projection, runner, audit, and appendix
    modules.

## Alternatives Considered

### Reorganize Directories Without Changing Ownership

Rejected. It would preserve distributed transitions, duplicate concepts, and
the same change radius under different paths.

### Keep The Current Runner And Add A Browser Wrapper

Rejected. The current runner bypasses OAuth, installer/binding behavior, signed
webhook intake, and complete external cleanup. A browser wrapper would hide,
not close, those gaps.

### Use One `overall-dod` Release Scenario

Rejected. Parallel clean integration, forced conflict, rework, replan, waits,
and crash recovery have different or mutually exclusive terminal semantics.
One run cannot provide a clear causal verdict for all of them.

### Require Real Codex For Every Fault Scenario

Rejected as the default. The canonical customer journey must use real Codex.
Forcing Codex to randomly produce a conflict, wait, invalid plan, timeout, or
rework makes the tested cause non-deterministic. Focused scenarios use the real
boundary only when that boundary's behavior is the acceptance fact.

### Create More Runtime Services Or Cross-Role Domain Packages

Rejected. The four current runtime boundaries match deployment and credential
ownership. Additional services would increase operational and contract cost
without solving internal semantic duplication.

### Put Every Domain Model In performer-api

Rejected. Shared contracts are not shared ownership. Podium-only installation
and authentication models belong to Podium; Conductor-only transition behavior
belongs to Conductor.

### Keep Both Old And New Implementations During A Long Migration

Rejected. Long-lived dual paths recreate the source-of-truth problem. Migration
is incremental by vertical slice, but each accepted slice cuts over all of its
in-repository callers and removes the replaced path promptly.

## Consequences

Positive consequences:

- change radius aligns with business capabilities;
- state and failure semantics become testable without running the full product;
- role teams and agents can work in parallel with less file contention;
- release evidence mirrors the actual customer journey;
- the explicit business catalog makes missing or weakly proved customer jobs
  visible;
- core and major changes receive full real proof while localized work avoids an
  unnecessary full live run;
- every real Linear artifact is evaluated as a customer surface rather than
  accepted merely because its ids and states match;
- focused failures become reproducible and diagnosable;
- storage, BFF, and runtime boundaries gain explicit contract tests;
- obsolete architecture becomes easier to identify and remove.

Costs and risks:

- contract and aggregate design creates an initial sequential gate before broad
  parallel work begins;
- temporary merge pressure will concentrate around shared DTOs, composition
  roots, and storage migrations;
- deleting shadow or legacy paths requires consumer and packaging audits;
- a real browser/OAuth/webhook acceptance environment requires release
  operations, public HTTPS, stable test workspace administration, and cleanup
  discipline;
- model-based experience review adds cost and variability, requiring frozen
  inputs, calibrated revisions, hard deterministic gates, and audited semantic
  adjudication;
- moving too many files before centralizing semantics would create churn, so
  migration order must be enforced;
- parallel work without exclusive file ownership would increase conflicts and
  must be rejected during planning.

## Open Questions

1. Will the release operator complete OAuth interactively, or may the browser
   start from a pre-authenticated Linear session while still executing the real
   authorization UI?
2. What measured service limits should tune the default four-branch concurrency
   and total runtime budgets for routine risk-selected and one-time G4 runs?
3. Is JSON storage retained as a supported local adapter or reduced to a test
   adapter after PostgreSQL parity is established?
4. Are any current Performer Linear/tracker/workspace modules consumed outside
   this repository or imported as a supported library surface?
5. Which fault scenarios, beyond the canonical customer journey, are required
   to use real Codex
   despite the reproducibility trade-off?
6. Is `symphony_acceptance` the accepted package/CLI vocabulary, or should the
   runner retain an `e2e` name while still separating test levels?
7. Which reviewer model snapshot and profile become the initial calibrated
   `linear_customer_experience` revision?
8. After historical-diff calibration, should the presumptive major-change
   thresholds remain 12 production files and 500 executable lines?

## Approval Gate

Before implementation:

- review and accept or revise this ADR;
- resolve the open questions that affect contracts or release infrastructure;
- create `tasks/plan.md` with the dependency graph, parallel workstreams, merge
  gates, risks, and verification checkpoints;
- create `tasks/todo.md` with small tasks, dependencies, exclusive file scopes,
  acceptance criteria, and verification commands;
- do not modify product docs to claim this target architecture until the
  corresponding behavior has passed acceptance.
