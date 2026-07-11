# Coordinator Business Scope And Removal Catalog

Status: business-design draft for scope confirmation. This document does not
authorize production edits. Every decision below is derived from the customer
journey and product invariants rather than the current implementation shape.

## Scope Ledger

### authorized

- Reconstruct the current Managed Run business from the product design and the
  reachable `_coordinator_` runtime path.
- Define the business boundary between Codex and Conductor.
- Identify behavior that has no place in the approved product design.
- Identify old implementation shapes that may be deleted only after the same
  business invariant has a replacement owner.
- Honor the explicit product constraint that Symphony does not support
  cross-model planning or execution.

### required_consequences

- Preserve the canonical customer journey from a delegated Linear issue to one
  independently verified repository delivery.
- Preserve deterministic safety, recovery, visibility, and customer-controlled
  approval semantics even where their current implementation is replaced.
- Treat parallel work as a Codex proposal that Conductor validates and executes
  safely, not as permission for Codex to mutate authoritative run state.
- Fail closed when an input does not correspond to an accepted plan, active
  turn, recorded wait, or delivery attempt.

### out_of_scope

- Production-code removal or refactoring.
- Adding a new customer workflow, integration, backend, model, state, or API.
- Reintroducing capabilities that are present only in a catalog or old plan but
  absent from the current approved runtime design.

### assumptions_requiring_approval

- None for producing this catalog. Items under `PRODUCT_DECISION_REQUIRED` are
  not approved for implementation or removal.

### deferred_ideas

- Exact module and file deletion batches.
- State/repository migration mechanics.
- Verification strategy for the eventual implementation.
- Broader pruning outside the Conductor Managed Run core.

## Decision Authority

Business decisions in this catalog use the following precedence:

1. Explicit product constraints from the user: polling-only intake, Codex-only
   planning/execution, real customer workflows, safe parallel execution, and no
   inferred feature expansion.
2. The current runtime source documents: `runtime-pipeline.md`,
   `pipeline-state.md`, `gates-verification-integration.md`,
   `linear-projection.md`, and `runtime-profiles-backends.md`.
3. The accepted business-scenario catalog and architecture decision where they
   do not conflict with the current runtime sources.
4. Reachable code only as evidence of what exists. Existing code does not create
   a business requirement by itself.

When two approved documents disagree or a documented capability is absent from
the runtime, this catalog records a gap or product decision. It does not silently
choose the larger behavior.

## Business Outcome

The customer delegates one real Linear issue and receives one verified repository
delivery that is independently verified, durably recoverable, and understandable
from Linear and Podium without inspecting local process state.

The Managed Run is not a general DAG scheduler and it is not a multi-model agent
platform. Its work-item graph is a bounded execution contract for one customer
issue.

```text
delegated Linear issue
  -> one durable Managed Run
  -> Codex proposes a bounded plan
  -> Conductor accepts and freezes the safe contract
  -> Codex executes eligible work items
  -> Conductor independently verifies and integrates results
  -> final Definition-of-Done evidence and residual risks are recorded
  -> Linear and Podium show Done with current evidence
```

Anything that does not serve this outcome, an explicitly approved human-control
flow, or a required safety/recovery invariant is a removal candidate.

## Canonical Business Concepts

Each concept has one meaning and one authority. A field or object that cannot be
assigned to one of these concepts must justify a new customer-visible capability
before it enters the runtime.

| Concept | Meaning and authority |
|---|---|
| Delegation epoch | One continuous period in which the customer delegates a Linear issue to Symphony. Podium owns its polling and dispatch identity; a new epoch does not create a second Managed Run for the same bound-project/issue identity. |
| Dispatch lease | Podium's durable permission for one Conductor to accept and acknowledge one dispatch. It is not permission to start or submit a Performer turn. |
| Managed Run | The single durable execution aggregate for one bound-project/Linear-issue identity across dispatch retries and delegation epochs. Conductor owns its lifecycle. |
| Plan version | An immutable accepted execution contract proposed by Codex and accepted by Conductor. |
| Dependency overlay | An immutable, versioned set of validated customer-created Linear dependency edges appended to an accepted plan without rewriting it. |
| Work item | One bounded unit inside an accepted plan, not an independently routed customer job. |
| Gate snapshot | The immutable acceptance and verification contract bound to one work item and plan version, including step provenance, the global score threshold, and at least one authoritative step. |
| Turn lease | The durable permission for one exact planning or execution attempt to run and submit a result. |
| Managed approval/input wait | A customer decision required by the accepted business contract. It resumes through an exact recorded Linear state transition. |
| Runtime wait | A Codex approval, permission, or tool-input pause bound to one exact turn. It resumes through its exact Runtime Wait channel. |
| Verification input/outcome | The frozen Git/artifact facts and independent verdict for one execution result. |
| Output manifest | Conductor's immutable publication of one verified work item's usable output. |
| Projection snapshot | A read-only customer/operator view of durable facts in Linear or Podium. |

The following are not product concepts and must not return as alternative runtime
paths: generic pipeline/DAG nodes, mode-capacity schedulers, aggregate execution
nodes, standalone plan/execute/verify Linear phase issues, label-based routing,
or interchangeable model backends.

## Authorized State Causes

State changes are consequences of named business facts, never conveniences for
a driver loop or projection pass.

| State change | Only authorized cause |
|---|---|
| New/resumed run enters planning | An idempotently accepted dispatch has no accepted plan, or an approved revision explicitly starts a planning turn. |
| Planning becomes projecting plan | A valid plan version is accepted and the current durable state contract enters its plan-projection phase. |
| Projecting plan becomes awaiting approval | The accepted frozen plan explicitly requires approval. |
| Projecting plan/approval becomes ready | Plan application is complete and every required plan approval is recorded. |
| Todo becomes in progress | An atomic readiness decision commits a new fenced TurnLease. |
| In progress becomes in review | A matching fenced result and immutable execution handoff are accepted. |
| A run/work item becomes blocked | A typed blocker, wait, failed safety check, failed verification, or integration conflict has a valid in-run recovery action and records that action. |
| Managed blocked work becomes eligible again | The exact typed plan/work-item approval, business-input resolution, or approved revision for that run/item is recorded. |
| A failed or timed-out turn is retried | A typed retry decision reserves a fresh TurnLease; the old fence remains stale and cannot submit current state. |
| Verification-blocked work becomes eligible for rework | A typed rework decision preserves the failed verification evidence and authorizes a new execution attempt. |
| A runtime wait resumes | Its exact attempt/lease/turn wait channel receives the recorded approval, permission, or tool input and resumes that same runtime turn. |
| In review becomes done | Independent verification passes and the output manifest is durably published. |
| Run becomes ready again | More accepted work remains eligible after the current verified result or barrier. |
| Run becomes pre-delivery verified | All accepted work is Done/cancelled and every retained barrier has passed. |
| Any non-terminal run becomes failed | A typed unrecoverable setup/runtime/persistence failure is durable with a sanitized reason and no permitted same-run recovery path. |
| Run becomes done | All accepted work is Done/cancelled, retained checkpoints pass, final Definition-of-Done evidence and residual risks are recorded, changed-file/verification evidence is visible, and the parent Linear summary is current. |

A projection refresh cannot decide a terminal state; outside the explicitly
retained `projecting_plan` contract it cannot mutate authoritative business state.
A process exit, arbitrary comment, generic state flip, executor claim, or
duplicate dispatch is not by itself an authorized state cause.

## Codex And Conductor Boundary

"Scheduling is in Codex" has one precise meaning: Codex decides how the issue
should be decomposed and proposes dependencies and parallelizable slices. It does
not mean Codex owns authoritative eligibility, leases, verification, or terminal
state.

| Owner | Authorized business decisions |
|---|---|
| Codex planner | Interpret the delegated issue; propose work items, dependencies, file scope, acceptance conditions, and safe parallelism. |
| Codex executor | Implement exactly one accepted work item; report changed output, evidence, blockers, or a plan-revision request. |
| Conductor | Accept or reject the proposed contract; freeze versions; decide effective readiness; reserve and fence turns; enforce capacity; accept or quarantine results; verify independently; manage waits and recovery; integrate verified output; converge to one delivery. |
| Linear | Customer work surface, approval/input surface, and readable projection of authoritative state. |
| Podium | Polling intake, project/runtime binding, dispatch leasing, runtime configuration, and customer-facing control-plane views. |

Codex is the only planning and execution model. Verification remains a separate
trust role and may use the explicitly configured Codex or `local-verifier`
implementation; `local-verifier` is not an alternative planning/execution model.

## Canonical Managed-Run Journey

1. Podium discovers a delegated issue through polling and routes one idempotent
   dispatch to the uniquely bound Conductor.
2. Conductor creates or resumes the issue's single durable Managed Run.
3. A Codex planning turn proposes a bounded plan without changing repository
   files.
4. Conductor deterministically validates safety properties and freezes an
   immutable accepted plan version.
5. If the accepted contract requires customer approval, only the recorded
   approval for that exact plan or work item resumes it.
6. Conductor chooses every currently eligible work item. Independent eligible
   work may run concurrently when the accepted plan declares compatible file
   ownership and durable runtime capacity exists.
7. Before launch, Conductor durably reserves a fenced turn. Codex receives one
   work item plus its frozen contract and verified upstream inputs.
8. A Codex result is a claim. Conductor rejects stale or mismatched results,
   freezes the execution handoff, and independently runs the authoritative gate
   against that exact commit and artifact set.
9. Verified outputs become immutable manifests. Downstream work consumes only
   verified, deterministically joined inputs.
10. A blocker, approval request, tool-input wait, verification failure, or
    integration conflict becomes durable, sanitized, and visible with one
    concrete next action.
11. Completion occurs only after all accepted work and retained checkpoints
    satisfy the final Definition of Done, changed-file and verification evidence
    is visible, residual risks are recorded, and the customer projection is
    current.

## Business Capabilities In Scope

| Capability | Decision | Business reason |
|---|---|---|
| One delegated issue to one verified delivery (`B13`) | `KEEP_CORE` | This is the product's primary customer outcome. |
| Managed-run progress and failure visibility (`B14`) | `KEEP_CORE` | A run that cannot explain state and next action is not operable. |
| Idempotent run acceptance after deferred dispatch (`B15`) | `KEEP_BOUNDARY` | Replayed or resumed dispatch must converge on the same run rather than reset or duplicate execution. |
| Immutable plan acceptance and bounded revision | `KEEP_CORE` | Codex output is a proposal; execution must remain scoped and auditable. |
| Dependency readiness and safe parallel eligibility | `KEEP_CORE` | Codex proposes topology; deterministic state decides what may run now. |
| Durable turn reservation, fencing, retry, and restart | `KEEP_CORE` | Prevents duplicate execution and stale results from corrupting current work. |
| Independent gate execution and score threshold | `KEEP_CORE` | Executor claims cannot be the authority that approves their own work. |
| Verified manifests, deterministic branch join, and conflict visibility | `KEEP_CORE` | Downstream and final delivery must consume exact verified output. |
| Plan approval (`B17a`) | `KEEP_CURRENT_SCOPE` | It is an explicit customer authorization flow in the current product. |
| Work-item approval (`B17b`) | `KEEP_CURRENT_SCOPE` | It limits approval to the exact gated work item. |
| Missing business input (`B18`) | `KEEP_SEMANTIC_NARROWLY` | The affected work may resume only from a typed, recorded resolution. |
| Runtime approval/tool-input wait (`B19`) | `KEEP_CORE` | Real Codex waits require a durable Linear-visible resume channel. |
| Approved plan revision (`B20`) | `KEEP_CURRENT_SCOPE` | It is the controlled way to change scope or topology after acceptance. |
| Verified rework after a failed gate (`B21`) | `KEEP_CORE` | A failed result must be correctable without erasing evidence. |
| Integration conflict resolution (`B22`) | `KEEP_CORE` | Conflicting verified output must never be silently delivered. |
| Customer-added Linear dependency overlay (`B16`) | `KEEP_REQUIRED_GAP` | The current design explicitly requires the immutable overlay and records its absence as a product gap. Removing it requires an explicit product-design amendment. |
| Multi-model or alternative planning/execution backends | `REMOVE_SCOPE` | The product is Codex-only; speculative portability is not a customer capability. |

## Core Invariants To Preserve

These are the irreducible business rules. Their current code may be deleted only
after a new owner enforces the same rule atomically.

1. One bound-project/Linear-issue identity maps to one Managed Run across
   duplicate dispatches, restarts, and delegation epochs.
2. `DispatchLeaseRef` and `TurnLease` are different permissions owned by Podium
   and Conductor respectively. Their ids, fences, heartbeats, and expiry never
   alias, and neither lease grants the authority of the other.
3. A saved plan version is immutable; a topology or scope change creates an
   approved new version and preserves the old version.
4. Effective dependencies are the immutable accepted-plan dependencies union the
   active immutable `DependencyOverlay`; overlay changes reject cycles, stale or
   partial observations, and changes to already-started targets.
5. A work item starts only when effective dependencies are satisfied, required
   approval is recorded, no required barrier is pending, file scope exists, and
   capacity is available.
6. Parallel work starts only when every simultaneously active item is compatible
   under the accepted contract and has an independent durable turn reservation.
7. Every turn and result is bound to the same run, work item, plan version,
   policy revision, lease, fencing token, and turn identity.
8. A retry of a failed or timed-out turn always receives a fresh TurnLease and
   preserves stale-result rejection for the prior attempt.
9. Rework after verification failure is a distinct business action: it preserves
   failed evidence and explicitly authorizes a new execution attempt.
10. Every frozen gate retains step provenance and at least one authoritative
    step. The global pass threshold remains `3`; only score `>= 3` verifies a
    work item or satisfies a dependency. A `planner_inferred` step is advisory
    and cannot be the sole reason a work item fails the threshold.
11. Executor output never directly decides verification, Linear terminal state,
   durable run state, or final delivery.
12. Verification runs against the exact frozen execution handoff, not a mutable
   workspace or a branch head that may have moved.
13. Downstream work consumes only verified manifests; conflicting upstream output
   blocks visibly.
14. A managed approval/input wait resumes only the exact run or work item through
   its allowed recorded Linear state transition. An arbitrary comment or
   unrelated state change cannot resume it.
15. A runtime wait remains bound to its exact attempt, lease, turn, and wait
   identity and resumes through that same runtime channel; resolving it does not
   silently authorize a different turn.
16. Every blocking or terminal cause is durable and sanitized, appears in
   correlated operator logs and the relevant Linear projection, remains in
   parity with Podium API/report views, and includes a concrete next action.
17. `done` requires all accepted work/checkpoints, final Definition-of-Done
    evidence, visible changed-file and verification evidence, recorded residual
    risks, and a current parent Linear summary.

## Removal Catalog

### REMOVE_WITHOUT_REPLACEMENT

These behaviors have no customer job, are absent from the approved runtime
journey, or contradict a hard product rule. Their later code removal does not
require a replacement capability.

#### R1. Synthetic runtime-wait injection

Remove the ability to ask production Conductor/Performer paths to manufacture a
runtime approval wait. A real runtime wait must originate from an actual Codex
approval, permission, or tool-input event.

Remove together:

- `emit_runtime_wait_probe` and `runtime_wait_probe_seconds` settings;
- request-level `runtime_wait_probe` behavior;
- manufactured `approval_requested` results;
- real-run configuration that enables the manufactured wait.

Do not remove real runtime-wait capture, durable wait identity, Linear Human
Action projection, or exact-turn resume.

#### R2. Forced first-verifier-failure injection

Remove the behavior that exports a forced first verification failure and a
special local-verifier probe home. Nothing in the customer journey requests a
manufactured gate failure, and the current environment variables have no
authoritative verifier consumer.

Remove together:

- `force_first_verify_failure_for_replan`;
- `SYMPHONY_FORCE_FIRST_VERIFY_FAILURE_FOR_REPLAN`;
- `SYMPHONY_LOCAL_VERIFIER_PROBE_HOME`;
- real-run configuration that depends on this injection.

Do not remove real verification-failure handling, durable evidence, or rework.

#### R3. Legacy `human.answered` compatibility command

Remove the ignored `human.answered` command branch. The current product resumes
runtime waits through their recorded exact runtime channel and resumes managed
approvals from their exact Linear state transitions. Keeping an ignored legacy
command is an unauthorized compatibility surface.

#### R4. Implicit checkpoint fabrication

Remove the fallback that fabricates an empty checkpoint when a caller supplies an
unknown `after_work_item_id`. An unknown checkpoint is not a business event. The
operation must fail closed against the immutable accepted plan.

#### R5. Cross-model portability promise

Remove product wording and speculative runtime branches whose only purpose is to
support planning/execution models other than Codex. Preserve the explicitly
configured Codex/local-verifier verification-role choice, versioned per-role
profiles, higher-version acceptance with last-valid-config recovery, isolated
runtime homes, and the small backend adapter boundary that separates process I/O
from Conductor domain decisions.

### DELETE_WITH_REPLACEMENT

These are old implementation behaviors, not removable business capabilities.
Deletion is allowed only after the named replacement owns the invariant.

| Old behavior to retire | Required replacement owner |
|---|---|
| Coordinator methods perform several independent Store writes for one state transition. | One typed Engine command atomically commits the aggregate revision, state, and finite effects. |
| `next_ready_work_item()` decides eligibility and `start_work_item()` later mutates state without atomically rechecking the same facts. | A `ReserveTurn` decision rechecks effective dependencies, approvals, barriers, compatibility, and capacity in one transaction. |
| Active work and capacity are inferred from mutable payload fields and process observations. | Durable, expiring `TurnLease` records are the only capacity and fencing authority. |
| Driver-side checks protect result submission while the result mutation API itself lacks the full fence. | A typed `ApplyTurnResult` command carries and validates the complete fenced context. |
| Executor self-reported RED/GREEN, acceptance, and secret flags can act as the blocking verdict. | Executor reports remain diagnostic inputs; the frozen gate, exact Git handoff, deterministic checks, and independent verifier own the verdict. |
| Coordinator executes checkpoint shell commands directly while also deciding state. | A pure barrier decision emits a checkpoint effect; a command adapter executes it and submits a typed outcome. |
| Generic `reopen_blocked_run` and `reopen_blocked_work_item` turn any non-empty reason back into runnable work. | Typed approval, business-input resolution, rework authorization, and plan-revision commands validate the exact managed blocker and identity. |
| Runtime-wait resolution makes a work item generally eligible for another turn. | A typed runtime-wait decision resumes the same recorded attempt/lease/turn channel and cannot grant a new turn implicitly. |
| Linear projection ingests operator events and writes authoritative run/work-item state. | Typed operator commands own state changes; projection consumes immutable snapshots only. |
| Projection turns `verified` into `done` merely because it wrote a summary. | A completion decision proves every canonical Done condition; projection only renders the committed outcome. |
| The coordinator facade and its human/checkpoint/runtime-wait mixins expose a concrete Store as a general mutation surface. | After every caller uses Engine commands and read-only queries, delete the facade, mixins, and arbitrary public state mutators. |

### PRODUCT_DECISION_REQUIRED

No code may be removed or added for these items until the product decision is
recorded. The default is to preserve the current approved design. A documented
but missing capability is not implemented opportunistically during simplification.

| Decision | Current product position | Simplification option | Default until approved |
|---|---|---|---|
| Multiple managed work items versus one long Codex execution turn | One bounded plan, one turn per work item, deterministic readiness, and Linear child issues. | One Codex turn would remove most readiness, parallel join, per-item approval, and per-item projection behavior, but materially changes the customer product and recovery model. | Preserve bounded work items. |
| Intermediate checkpoints | Required after configured work-item groups and before convergence. | Remove them if exact per-item verification plus final Definition-of-Done verification is declared sufficient. | Preserve checkpoints. |
| Planner authoring micro-policy | Current design names verb-first titles, at most three criteria, XS/S/M, architecture decisions, and related fields. Gate provenance, authoritative steps, the global threshold, executable procedures, scope, dependencies, and parallel safety are not writing micro-policy. | Keep safety and gate-authority facts in the runtime contract; move only writing quality and decomposition coaching into the Codex prompt/rubric. | Preserve the current contract; do not add more heuristics or weaken gate authority. |
| Fixed plan-validation retry count | Retries must be bounded, but the business design does not justify the current exact count. | Define one explicit retry policy or make invalid planning a typed repair loop with a product-owned bound. | Preserve the current bound until decided. |
| Plan approval | Explicit `B17a` customer flow. | Remove only if every accepted plan is authorized by delegation itself. | Preserve. |
| Per-work-item approval | Explicit `B17b` customer flow. | Remove only if plan-level approval is declared sufficient for all sensitive work. | Preserve. |
| Plan revision | Explicit `B20` customer flow. | Remove only if an entire run must fail and restart whenever scope changes. | Preserve. |
| Exact final `DeliveryAttempt`, `DeliveryRecord`, and repository ref | The accepted architecture plan and business catalog require them, while the five runtime source documents currently define Done through final Definition-of-Done evidence, residual risks, changed-file/verification visibility, and current Linear summary and do not define these durable objects. | Amend the runtime sources to adopt the exact delivery objects, or remove them from the plan/catalog and retain the current canonical Done contract. | Do not implement or delete either contract until the product sources agree. |
| Generated-cache file exclusions in scope enforcement | Current code silently ignores selected generated paths; the business design does not define this relaxation. | Make allowed generated artifacts part of the frozen gate, or enforce all changed paths. | Treat as unresolved; do not broaden the ignore list. |
| `projecting_plan` durable state | Current pipeline state includes it, while the intended read-only projector/committed-effect architecture does not yet define whether it remains a business barrier or becomes effect health. | Define its exact entry/exit semantics and retain it, or migrate the public/durable state contract and source docs before removing it. | Preserve the state and current transition contract until decided. |
| `reviewing` and `verified` as separate durable states | Current design exposes both review and pre-completion convergence. | Merge only if independent verification and every final completion condition remain unambiguous and recoverable. | Preserve both states. |

## Target Business Owners

The simplified core needs one decision owner per business question. These names
describe responsibilities, not required class names.

| Business question | Single owner |
|---|---|
| May this proposed plan become product fact? | Planning decision |
| Which accepted work is eligible now? | Readiness decision |
| May this dispatch be accepted or acknowledged? | Podium dispatch-lease decision |
| May this exact turn be reserved, launched, retried, or reclaimed? | Conductor turn-lease decision |
| May this result affect current state? | Fenced result decision |
| What exact operator action may resume this blocked work? | Typed wait/approval decision |
| May a verification-blocked item execute rework without losing prior evidence? | Rework decision |
| Did the exact frozen output satisfy the authoritative contract? | Verification decision |
| Can verified outputs be joined without conflict? | Integration decision |
| Does the run satisfy every currently canonical Done condition? | Completion decision |
| What should Linear and Podium show? | Read-only projection from durable facts |

The process driver, Codex adapter, Git adapter, shell-command adapter, Store, and
Linear projector perform effects or persistence. They do not make the above
business decisions independently.

## Business-First Removal Sequence

1. Confirm this scope and resolve only the product decisions needed for the first
   deletion batch.
2. Remove `REMOVE_WITHOUT_REPLACEMENT` in independent slices; none of these
   removals may alter a retained real workflow.
3. Establish typed decision owners and atomic state/effect persistence while
   preserving every `KEEP_CORE` invariant.
4. In parallel after the shared command contract is stable, migrate planning,
   turn leases/results, typed waits, and completion/projection under disjoint file
   ownership.
5. Delete each old coordinator path only after all production consumers use its
   replacement owner.
6. Revisit optional product capabilities one decision at a time. Never infer a
   removal merely because it would reduce code, and never infer a feature merely
   because it is conventional or future-proof.

## Scope Lock For The Next Step

Until this document is approved:

- no production behavior is removed;
- no missing catalog capability is implemented;
- no planner/runtime contract is expanded;
- no cross-model abstraction is added;
- no generic resume or terminal-state shortcut is accepted;
- the next deliverable is a code-level deletion map derived from the approved
  business decisions, not from implementation volume or file size.
