# Three-Mode Runtime Pipeline

## Status

Product architecture RFC. This document defines a target direction. It does not
claim the described behavior has already shipped. Implementation is sequenced as
subprojects (S0–S5) at the end of this document.

This RFC evolves and absorbs:

- `docs/product/runtime-orchestration-architecture.md` (Conductor owns state,
  Performer is a short-lived worker) — extended to three Performer modes.
- `docs/product/symphony-linear-tree-skill.md` — the standalone skill is demoted
  to an optional offline importer (S5) rather than the primary decomposition
  path.
- `docs/superpowers/plans/2026-07-06-runtime-profile-codex-home-isolation.md` —
  superseded; its invariants, code anchors, and documentation tasks are absorbed
  into S0-c and extended from per-instance to per-mode isolation.

## Goal

Evolve Symphony from a single-stage executor into a three-stage
**plan → execute → verify** pipeline, orchestrated by Conductor, where Performer
runs in three modes and the model backend is pluggable.

The design must satisfy:

- decomposition happens inside the execution runtime, not in an external
  one-shot tool, so failure feedback can drive re-decomposition;
- every task has a gate designed and frozen *before* implementation, scored by a
  calibrated 0–4 rubric with a global pass threshold;
- verification runs as an isolated runtime, against an immutable snapshot of the
  executor's output, so scoring cannot be self-reported;
- executors run fully in parallel, bounded only by typed capacity limits and
  dependency constraints;
- capacity limits are versioned, configured on Podium, and pushed to Conductor,
  per mode;
- the scheduling pipeline is observable on Podium, including a *conditional*
  predicted call order for all pending tasks;
- scheduling respects Linear `blocks` relations and a hard rule that a task's
  downstream cannot dispatch until that task's verify has passed;
- Conductor's durable graph is the single scheduling source of truth; Linear is
  a projection and collaboration surface.

## Why This Design

### Same runtime, real feedback loop

An earlier idea placed decomposition in a standalone Claude skill. That failed
the ADaPT/LLMCompiler feedback model because the planner was an external,
one-shot process whose only channel back to execution was Linear. There was no
control loop that could observe a failure and re-invoke the planner.

The three-mode design keeps the feedback loop intact without requiring a single
OS process. What matters is a **persistent control loop that can observe failure
and reschedule the planner**. Conductor is that control loop. All three modes are
Conductor-orchestrated workers sharing Conductor's durable state, so an executor
or verifier failure is observable and can be routed back to planning.

This is the orchestrator-workers pattern: Conductor is the orchestrator;
plan/execute/verify are workers. It also maps to the LLMCompiler triad of
Planner / Executor / Joiner.

### Prior art

- **LLMCompiler** ([arXiv 2312.04511](https://arxiv.org/abs/2312.04511)): a
  planner streams a DAG of tasks with explicit dependencies; a task-fetching unit
  dispatches tasks once dependencies are met; a joiner decides completion or
  replanning.
- **ADaPT** ([arXiv 2311.05772](https://arxiv.org/abs/2311.05772)): decompose
  as-needed and recursively, triggered by execution failure, adapting to the
  executor's capability. Informs the failure-driven re-decomposition loop (S4).
- **Anthropic, Building Effective Agents**
  ([link](https://www.anthropic.com/engineering/building-effective-agents)):
  orchestrator-workers and evaluator-optimizer patterns; add agentic complexity
  only when it demonstrably helps.

## Architecture Invariants

These invariants are normative. Every subproject must preserve them.

1. Conductor's durable graph store is the scheduling source of truth.
2. Linear is a projection / collaboration surface, not the sole scheduler state.
3. Every dispatch is stamped with a `graph_revision` and a `policy_revision`.
4. Every execute attempt binds to an immutable `gate_snapshot_hash`.
5. Every verify attempt validates exactly one `execute_attempt_id` against
   exactly one `gate_snapshot_hash`.
6. Dependency satisfaction means the upstream node's verify passed, not that its
   execute completed.
7. Replanning replaces a graph node with a subgraph atomically, as a new graph
   revision.
8. The verifier runtime cannot write implementation artifacts or mutate gates.
9. The planner runtime cannot write verification verdicts or run implementation.
10. The executor runtime cannot mutate frozen gates or verification verdicts.
11. Isolation is required per mode at both the model-home level (`CODEX_HOME` and
    equivalents) and the workspace/artifact-snapshot level.
12. Capacity accounting is lease-based and crash-recoverable.

## Core Architecture

```text
Podium
  └─ config push: versioned scheduler policy + per-mode runtime profiles
                  (single configuration channel)

Conductor  (orchestrator / control loop)
  ├─ Durable Graph Store        (scheduling source of truth)
  │    ├─ graph revisions
  │    ├─ graph nodes / blocks edges
  │    ├─ frozen gate snapshots
  │    ├─ execute attempts
  │    └─ verify attempts
  │
  ├─ Plan Validator             (deterministic, non-LLM)
  │
  ├─ Scheduler
  │    ├─ typed capacity (by_mode) + lease accounting
  │    ├─ dependency-satisfaction predicate (verify-passed)
  │    └─ predicted-order simulation (conditional)
  │
  ├─ Runtime Dispatcher
  │    ├─ performer --mode plan      Planner worker
  │    ├─ performer --mode execute   Executor worker
  │    └─ performer --mode verify    Verifier worker
  │
  ├─ Artifact Store
  │    ├─ patches / evidence
  │    ├─ verification input bundles
  │    └─ task output manifests
  │
  └─ Linear Sync                (projection + reconciliation)
       ├─ issue / blocks projection
       └─ ingestion of human-made Linear changes

Each mode = independent dispatch / process / workspace / model session, under a
per-mode isolated runtime environment.
```

### Two orthogonal dimensions

Mode and backend are independent axes:

- **mode**: `plan` | `execute` | `verify` — what kind of work this run does.
- **backend**: Codex | Claude | other — which model runs it.

Each mode can be assigned a different backend, carried by the runtime profile
(S0-c). The first implementation may use Codex for all three, but backend is a
pluggable, per-mode choice.

## State Model

The pipeline uses three distinct state layers. They must not be collapsed into a
single phase enum; doing so is the primary source of scheduling and replan bugs.

### 1. GraphNode state

Each business issue and each subtask is a graph node with its own lifecycle:

```text
PLANNED
READY
EXECUTING
EXECUTE_FAILED
VERIFYING
VERIFY_PASSED
VERIFY_FAILED
REWORKING
REPLANNING
SUPERSEDED        (replaced by a subgraph, see Replan Rewrite)
AWAITING_HUMAN
FAILED
```

`READY` means all dependencies are satisfied (upstream verify passed) and the
node may be dispatched, subject to capacity. `SUPERSEDED` marks a node whose work
has been replaced by a decomposition subgraph.

### 2. Attempt state

Each execute or verify run is a separate, individually stored attempt:

```text
PENDING
RUNNING
SUCCEEDED
FAILED
CANCELLED
TIMED_OUT
```

Execute attempts and verify attempts are stored separately. A node may accumulate
multiple execute attempts (rework) and multiple verify attempts, each immutable
once terminal.

### 3. Aggregate parent state

A parent node's state is derived from its child subgraph, never authored
directly. `IN_PROGRESS` below is a derived aggregate display state, not an
authored/stored GraphNode state:

```text
all exit children VERIFY_PASSED         → parent VERIFY_PASSED
any child terminal FAILED (unrecoverable) → parent FAILED
any child AWAITING_HUMAN                  → parent AWAITING_HUMAN
otherwise, children still active          → parent IN_PROGRESS (derived)
```

Worked example — issue `A` planned into `A1 → A2 → A3`:

- `A` is a parent node in `IN_PROGRESS`; it is not itself dispatched to execute.
- `A` reaches `VERIFY_PASSED` only when `A3` (the exit node) verify-passes and all
  nodes in its subgraph are `VERIFY_PASSED` or `SUPERSEDED`.
- If `A1` execute fails and rework runs, `A1` is `REWORKING`; `A` stays
  `IN_PROGRESS`.
- If `A3` is not yet dispatchable, `A3` is `PLANNED`/blocked, not `READY`.
- A failed verify belongs to a specific verify *attempt* on a specific node, never
  to the parent issue directly.

## Gate Immutability

"Gate frozen" is enforced by an immutable snapshot bound by hash, not by prose in
a Linear description (which any actor could edit).

### GateSpecSnapshot

```yaml
gate_spec:
  id: gate_<uuid>
  task_id: <node id>
  version: 1
  created_by: <planner_attempt_id>
  created_at: <ts>
  content:
    acceptance_criteria: [...]
    verification_procedure: [...]     # executable commands or explicit steps
    rubric:
      "0": ...
      "1": ...
      "2": ...
      "3": ...
      "4": ...
    pass_threshold: 3               # records the global threshold for audit; cannot override it
  hash: sha256(canonical(content))
  frozen: true
```

Rules:

- A node cannot enter `EXECUTING` until it is bound to a `gate_snapshot_hash`.
- The execute attempt may read that snapshot but cannot mutate it.
- The verify attempt must use the same `gate_snapshot_hash`.
- Changing a gate requires the planner to create a new gate version or a new node
  via replan; in-place mutation is forbidden.
- Linear may render the gate for humans, but the Conductor snapshot is
  authoritative.

## Rubric Calibration

Per-task rubrics may specialize wording, but the global semantics and pass
threshold are fixed so scores are comparable across tasks and stable for the
verifier.

```text
0 = no valid implementation, or unverifiable
1 = attempted, but the core gate fails
2 = partial; mock-only; insufficient evidence; not release-worthy
3 = gate passes with real-run evidence; non-blocking concerns only
4 = gate passes with robust evidence and edge-case coverage

pass_threshold = 3   (a node's verify passes only at score >= 3)
```

Score 2 is non-passing by design, even if some checks succeeded; it represents
insufficient confidence for dependency satisfaction. It may record useful partial
progress, but it does not satisfy dependencies and cannot unblock downstream
dispatch.

This aligns with AGENT.md's rubric and its hard gate that mock-only evidence
caps at 2/4. Individual tasks may sharpen criteria but must not redefine the
global pass threshold, which is fixed at 3.

## Verification Handoff

The verifier is isolated, but it must verify the executor's *actual* output. This
requires an explicit, immutable handoff rather than reusing the executor
workspace (breaks isolation), re-checkout of main (wrong object), or reading a
Linear self-summary (self-report).

### Verification Input Snapshot

Every terminal execute attempt produces an immutable bundle:

```yaml
verification_input:
  task_id: <node id>
  execute_attempt_id: <id>
  base_revision: <git sha before>
  patch_uri: <artifact store>
  patch_hash: <sha256 of patch>
  expected_result_tree: <git tree sha after applying patch>
  result_revision: <optional git commit sha; provenance/optimization only>
  artifact_uris:
    - { uri: ..., sha256: ..., type: ... }
  declared_commands: [...]          # informational only, not trusted as evidence
  evidence_uri: <artifact store>
  gate_snapshot_hash: <hash>
```

Verifier canonical workflow (apply-patch is the normative path; `result_revision`
is used only for provenance or as an optimization after verifying it resolves to
the same tree):

1. create a fresh, disposable workspace;
2. checkout `base_revision`;
3. fetch `patch_uri` and verify `patch_hash`;
4. apply the patch;
5. assert the resulting git tree hash equals `expected_result_tree`;
6. optionally assert `result_revision`, if present, resolves to the same tree;
7. pull read-only artifacts and verify their hashes;
8. load the frozen gate snapshot by hash;
9. execute the gate's verification procedure;
10. emit a verdict via Conductor API.

Directly checking out `result_revision` as the primary path is forbidden: it may
carry executor commits, temporary merges, or state not belonging to this attempt,
which would weaken the "executor output is an immutable bundle" boundary.

`declared_commands` are context only; a passing verdict must come from the
verifier actually running the gate procedure, never from the executor's
self-attested commands.

## Runtime Permission Boundaries

Isolation includes capability limits, not just separate homes.

- **Planner**: may propose graph/gate (proposal only); cannot run
  implementation; cannot write verify verdicts.
- **Executor**: may modify code, produce patches, upload evidence; cannot mutate
  frozen gates; cannot write verify verdicts.
- **Verifier**: read-only checkout + disposable workspace; may run tests and read
  artifacts; cannot push commits, cannot modify task content except writing the
  verdict via Conductor API, cannot change gates or the dependency graph, cannot
  produce rework patches.

## Backend Abstraction

Backends differ in capability, so the scheduler and phase logic must depend only
on a minimal interface, with per-mode capability requirements.

```text
RuntimeBackend:
  prepareEnvironment(profile, mode) -> RuntimeEnv
  startAttempt(input)               -> AttemptHandle
  streamEvents(handle)              -> events
  cancel(handle)
  collectArtifacts(handle)          -> ArtifactManifest

mode_requirements:
  plan:    { requires_workspace: false, requires_structured_output: true,
             graph_writes: proposal_only }
  execute: { requires_workspace: true,  requires_shell: true,
             can_write_patch: true }
  verify:  { requires_workspace: true,  requires_shell: true,
             can_write_patch: false }
```

A backend that cannot meet a mode's requirements is ineligible for that mode.
Scheduler and phase logic must not embed backend-specific behavior.

## Conductor Graph vs Linear

There are two potential state sources: Linear's issue graph and Conductor's
durable state. To avoid race conditions, the authority boundary is explicit.

- Conductor's durable graph store is authoritative for scheduling.
- Linear is a projection and human collaboration surface.
- Human-made Linear changes (e.g., edited `blocks`) enter Conductor only through
  an ingestion/reconciliation step, never directly as scheduler truth.
- Human edits that would mutate frozen gates, historical attempts, or past graph
  revisions are rejected or converted into a new graph-revision proposal; edits to
  a gate rendered in a Linear description never alter the authoritative snapshot.
- Conductor writes to Linear idempotently, stamping each issue with metadata:

```yaml
symphony:
  graph_id: ...
  node_id: ...
  plan_attempt_id: ...
  gate_snapshot_hash: ...
  conductor_revision: 17
```

All graph changes follow: `planner proposal → validate → commit graph revision →
sync to Linear`. The planner never writes Linear as a primary database.

## Plan Validation

The planner has broad authority (it authors the DAG, gates, and rubrics). Its
output must pass a deterministic, non-LLM `PlanValidator` before it is committed
to the graph: `planner output → PlanValidator → commit graph`.

The validator rejects a plan unless:

1. every subtask has a gate;
2. every gate has an executable verification procedure;
3. every rubric defines scores 0–4;
4. the gate records the global `pass_threshold = 3`; task-local thresholds may not
   lower it (the threshold is globally fixed and recorded only for audit);
5. the dependency graph is acyclic;
6. all `blocks` edge directions are legal;
7. entry and exit nodes are computable;
8. subtask count is within the policy limit;
9. no gate depends on executor-only workspace state;
10. no gate requires credentials the verifier cannot access.

## Phase / Pipeline Flow (S1)

The pipeline expressed over GraphNode state:

```text
PLANNED → (validate) → READY → EXECUTING → VERIFYING → VERIFY_PASSED
                          ▲          │            │
                          │          │            └─ VERIFY_FAILED → REWORKING
                          │          │                                   │
                          │          └────────── rework re-execute ◄─────┘
                          │
                          └── REPLANNING ◄── rework limit exhausted (S4)
                                   │
                                   └── replaces node with validated subgraph
```

- Whether a business issue is decomposed, and how deeply, is decided by the
  planner model, not a hardcoded size threshold.
- The planner may decide no decomposition is needed and emit a single node.
- First implementation is one-directional (`plan → execute → verify`). The
  `REPLANNING` back-edge is S4.
- `AWAITING_HUMAN` is reachable from any state on escalation (see Human
  Escalation).

## Scheduling Foundation (S0)

### S0-a: Typed capacity + versioned Podium-pushed policy

Capacity moves from one global number to versioned per-mode buckets:

```yaml
scheduler_policy:
  policy_id: ...
  version: 12
  effective_at: <ts>
  capacity:
    global: 12
    by_mode:
      plan: 2
      execute: null     # no mode-local cap; still bounded by global + deps
      verify: 4
```

Semantics:

- `null` means **no mode-local cap, not infinite total capacity**. Effective
  availability is computed as:
  `available_global = global - total_active`;
  `available_execute = available_global` when `by_mode.execute` is null, else
  `min(available_global, execute_cap - execute_active)`.
- Podium owns policy per runtime group and pushes it to Conductor over a single
  configuration channel (shared with runtime profiles, S0-c), reusing existing
  outbound runtime channels.
- Conductor only accepts a policy with a higher `version`, persists the active
  policy locally, and keeps local defaults when Podium is unreachable.
- A policy update does not preempt running tasks unless explicitly configured; if
  active count exceeds a new lower limit, Conductor stops new dispatch but does
  not kill in-flight work. New dispatches use the latest policy.

Capacity accounting is lease-based so a crashed worker does not leak capacity:

```yaml
worker_lease:
  lease_id: ...
  fencing_token: ...
  mode: execute
  node_id: ...
  attempt_id: ...
  acquired_at: <ts>
  heartbeat_at: <ts>
  expires_at: <ts>
```

Leases are renewed by live workers and reclaimed on expiry. A worker may commit
attempt results only if it still holds the active lease token; stale workers
whose lease has expired or been superseded are fenced from writing terminal
results.

### S0-b: Dependency-satisfaction predicate + observability

S0-b implements the scheduling *abstraction* and observability, but does not
claim full verify-gating before the verifier exists (S3). Its first job is to
introduce the hook and the reporting model; the `verify_passed` predicate is only
enabled once S3 is present.

- Introduce a pluggable `DependencySatisfactionPolicy`:
  - default (pre-S3): `blocker satisfied = blocker terminal success`;
  - target (enabled in S3): `blocker satisfied = blocker VERIFY_PASSED and
    gate_score >= pass_threshold`.
- The dispatchability check consults this predicate instead of a hardcoded
  `phase == DONE`.
- Linear `blocks` remains a required precondition and is reused as-is.

Observability — Conductor reports scheduler state; Podium exposes a read-only
pipeline view:

- **Current pipeline detail**: per mode, active vs. limit, queued count, and
  which nodes are in plan / execute / verify.
- **Conditional predicted call order**: a topological simulation over the current
  graph, capacity, and verify state. It is explicitly conditional, not a
  commitment:

```yaml
prediction_basis:
  graph_revision: 42
  policy_revision: 7
  assumption: unknown verifies pass
  generated_at: <ts>
```

Each pending node is shown with its basis rather than a bare sequence:

```yaml
node: B
predicted_position: 5
blocked_by:
  - "A: verify not passed"
earliest_mode: execute
confidence: conditional
```

The prediction refreshes as tasks complete, as new issues/blocks appear, and as
S4 re-decomposition rewrites the graph.

### S0-c: Runtime profile + per-mode CODEX_HOME isolation

Absorbs and extends
`docs/superpowers/plans/2026-07-06-runtime-profile-codex-home-isolation.md`.

**Absorbed invariants (unchanged intent):**

1. Podium owns managed project runtime profile inputs for model-facing settings.
2. Conductor materializes dedicated managed runtime state, including an isolated
   `CODEX_HOME`, without owning model turn semantics.
3. Performer consumes the provided runtime environment and must not fall back to
   the operator's global `~/.codex` in managed mode.

**Extensions for the three-mode pipeline:**

- Isolation moves from per-instance to **per-mode**: plan, execute, and verify
  each run under their own isolated `CODEX_HOME` (and equivalents for other
  backends). Note this is necessary but not sufficient for verifier isolation —
  workspace/artifact-snapshot isolation (see Verification Handoff) is also
  required.
- The runtime profile carries the **backend selection** per mode, making
  `codex_profile` one case of a general per-mode runtime profile.
- Runtime-profile push and scheduler-policy push share the same Podium →
  Conductor configuration channel.

**Preserved discipline:** documentation-first posture; docs must not claim the
managed `~/.codex` fallback removal shipped unless it lands in the same change.
The absorbed plan's code anchors remain the S0-c implementation checklist:

- `packages/podium/src/podium/podium_shared.py` → `sanitize_codex_profile`
- `packages/conductor/src/conductor/conductor_workflow.py` →
  `generate_workflow_content`, `_codex_profile`, `_managed_resource_mismatches`
- `packages/conductor/src/conductor/conductor_service.py` →
  `_build_instance_candidate`, `_materialize_instance`, `_runtime_env`
- `packages/conductor/src/conductor/conductor_runtime.py` → `_process_env`
- `packages/conductor/src/conductor/conductor_models.py` → `InstanceRecord`
- `packages/performer-api/src/performer_api/config.py` → `CodexConfig`
- `packages/performer/src/performer/codex_client.py` → `_codex_sdk_env`

## Failure-Driven Re-Decomposition (S4, ADaPT)

When a node's verify fails, it enters `REWORKING`. If rework reaches its limit,
the node does not go straight to `FAILED`; it enters `REPLANNING`, which produces
a validated subgraph that replaces the failing node.

### Replan graph-rewrite invariant

When node `T` is decomposed into subgraph `G` (entry nodes `G_in`, exit nodes
`G_out`):

1. `T` is marked `SUPERSEDED`.
2. All of `T`'s upstream blockers connect to `G_in`.
3. All of `T`'s downstream dependents connect to `G_out`.
4. A dependent of `T` becomes dispatchable only when all `G_out` nodes are
   `VERIFY_PASSED`.
5. The rewrite commits atomically as a new `graph_revision`.
6. The scheduler only schedules the current active `graph_revision`.

Replan replaces a node with a subgraph; it never leaves the old node satisfiable
or the new nodes detached. Example: if `A blocks T` and `T blocks B`, and `T` is
replaced by `T1 -> T2`, the rewrite yields `A blocks T1` and `T2 blocks B`.
Because all modes run in Conductor's control loop, the failure is observable and
the loop closes.

## Patch Integration and Conflict Model

Fully parallel executors create a real integration problem: two independent nodes
may both verify-pass while modifying overlapping parts of the repository. Passing
verification in isolation does not guarantee that the combined repository state is
still valid.

The minimum required model is:

- each execute attempt runs against a computed input baseline;
- for entry nodes, the baseline is the graph's base revision;
- for dependent nodes, the baseline is the integrated result of all verified
  blockers or the verified output manifests explicitly named as inputs;
- independently verified patches are **not** automatically treated as globally
  integrated;
- Conductor owns a deterministic integration step or integration queue;
- if verified patches conflict, the affected node or graph escalates to
  `AWAITING_HUMAN` or `REPLANNING` rather than silently merging;
- a downstream node may consume an upstream node only through a verified output
  manifest whose code revision / patch has been integrated into the downstream
  baseline, or is explicitly listed as an input artifact.

This RFC does not require a full merge engine in the first implementation, but it
does require the architecture to acknowledge that `VERIFY_PASSED` on parallel
nodes is not, by itself, a statement about the global integrated repository
state.

## Human Escalation

Not every abnormal condition should become `FAILED`. `AWAITING_HUMAN` is retained
as a first-class terminal-until-resolved state, reachable from any node state,
with a structured reason:

```text
AWAITING_HUMAN.reason ∈ {
  PLAN_INVALID,
  GATE_UNEXECUTABLE,
  LINEAR_SYNC_CONFLICT,
  CREDENTIAL_REQUIRED,
  REPLAN_LIMIT_EXCEEDED,
  BACKEND_UNAVAILABLE,
  CAPACITY_STARVED,
}
```

Consistent with AGENT.md, human intervention uses a Linear child issue; the human
completing that issue is what resumes the affected node.

## Deliberate Non-Goals

- **Typed inter-task variable passing (ReWOO / LLMCompiler variables).** Not in
  scope. However, to avoid downstream tasks guessing upstream outputs from repo
  or Linear prose, the architecture includes a **minimal, untyped task output
  manifest** published only after verification passes:

  ```yaml
  task_outputs:
    node_id: ...
    verify_attempt_id: ...
    gate_snapshot_hash: ...
    score: 3
    code:
      base_revision: ...
      patch_uri: ...
      expected_result_tree: ...
      integrated_revision: ...   # optional, if an integration step exists
    artifacts:
      - { name: migration_plan, uri: ..., type: markdown, sha256: ... }
  ```

  The manifest is published by Conductor only after a verifier passes the node.
  It is never trusted when produced solely by the executor. This manifest is a
  lookup surface, not a variable-binding system.
- **Cross-runtime decomposition by an external skill.** Decomposition lives in
  the execution runtime; the standalone Linear tree skill is demoted to S5.
- **Hardcoded issue-size thresholds.** The planner decides decomposition depth.

## Subproject Build Order

```text
S0 Scheduling + runtime-profile foundation
   ├─ S0-a versioned typed capacity (by_mode) + lease accounting +
   │        Podium-pushed policy
   ├─ S0-b pluggable dependency-satisfaction predicate + pipeline observability
   │        (conditional predicted order); verify-gating predicate defaults to
   │        terminal-success until S3
   └─ S0-c runtime profile + per-mode isolated CODEX_HOME + pluggable backend
            (absorbs the CODEX_HOME isolation plan)
        │
S1 State + graph + artifact-model foundation — three-layer state model
   (GraphNode / Attempt / Aggregate), graph store, VerificationInputSnapshot,
   TaskOutputManifest schema, and plan→execute→verify flow
        │
S2 Planner mode — gate planner becomes an execution decomposer: subtasks +
   blocks + pre-frozen GateSpecSnapshot per subtask; output passes PlanValidator;
   committed as a graph revision and projected to Linear
        │
S3 Verifier mode — isolated runtime executing gates against Verification Input
   Snapshots, scoring 0–4; enable verify-passed as the dependency predicate
   (depends on S0-c per-mode isolation and S0-b predicate hook)
        │
S4 ADaPT failure-driven re-decomposition (REPLANNING + atomic graph rewrite)
        │
S5 (optional) offline import skill — batch-create a hand-written plan into a
   Linear tree; the earlier standalone skill is demoted to here, or dropped
```

S0 is the deepest foundation: once the three-stage pipeline exists, parallel
executors, typed capacity, lease accounting, and verify gating must be expressible
by the scheduler, so scheduling and runtime-profile ownership are settled first.

## Documents Evolved or Superseded

- **Supersedes:**
  `docs/superpowers/plans/2026-07-06-runtime-profile-codex-home-isolation.md`
  (absorbed into S0-c, extended to per-mode isolation).
- **Evolves:** `docs/product/runtime-orchestration-architecture.md` (three
  Performer modes; per-mode runtime environment boundary; graph store as
  scheduling authority).
- **Evolves:** existing gate-tree acceptance semantics in `packages/performer`
  (`acceptance.py`, `REVIEWING`) toward pre-frozen gate snapshots and an isolated
  verifier runtime.
- **Demotes:** `docs/product/symphony-linear-tree-skill.md` to the optional S5
  importer role.

When S0-c is implemented, the supporting docs listed in the absorbed plan
(`security-model.md`, `runtime-installer-and-updates.md`, `product-shape.md`,
`README.md`, `CLAUDE.md`, `AGENT.md`, `docs.md`, `WORKFLOW.md`,
`WORKFLOW.smoke.md`) must be aligned to the per-mode isolated `CODEX_HOME`
invariant.

## Success Criteria

1. A business issue can enter planning and be decomposed into a `blocks` DAG whose
   subtasks each carry a pre-frozen `GateSpecSnapshot` (rubric 0–4, pass
   threshold), committed as a graph revision and projected to Linear.
2. Node, attempt, and aggregate-parent states are tracked as three distinct
   layers, and a parent reaches `VERIFY_PASSED` only via child aggregation.
3. Executors run in parallel up to typed, versioned, lease-accounted capacity,
   bounded by `blocks` and verify gating; a downstream node never dispatches
   before its blocker's verify passes at score >= 3.
4. The verifier runs as an isolated runtime, verifying an immutable Verification
   Input Snapshot, and cannot mutate gates or write implementation artifacts.
5. Verified task outputs are published only by Conductor after a verifier passes a
   node, as a TaskOutputManifest bound to `verify_attempt_id` and
   `gate_snapshot_hash`.
6. The planner's output is committed only after passing the deterministic
   PlanValidator.
7. Capacity and runtime profiles are configured on Podium and pushed to Conductor
   over one versioned configuration channel; stale/lower-version policy is
   rejected.
8. Podium exposes a read-only pipeline view with per-mode detail and a
   conditional predicted call order carrying its prediction basis.
9. Managed mode never falls back to the operator's global `~/.codex`; each mode
   uses a Conductor-provisioned isolated runtime environment.
10. Model backend is selectable per mode via the runtime profile without changing
   scheduler or phase logic.
11. Abnormal conditions escalate to `AWAITING_HUMAN` with a structured reason
    rather than collapsing into `FAILED`.

## Verification

Documentation-consistency and symbol-existence checks during the doc phase:

```bash
grep -Rni "CODEX_HOME\|~/.codex\|codex_profile\|managed mode\|runtime profile" \
  docs README.md CLAUDE.md AGENT.md docs.md WORKFLOW.md WORKFLOW.smoke.md

grep -Rni "SchedulerPolicy\|global_capacity\|is_dispatchable\|readiness_counts\|by_mode" \
  packages/conductor/src/conductor

grep -Rni "sanitize_codex_profile\|generate_workflow_content\|_codex_profile\|_managed_resource_mismatches\|_build_instance_candidate\|_materialize_instance\|_runtime_env\|_process_env\|InstanceRecord\|CodexConfig\|_codex_sdk_env" \
  packages
```

Each implementation subproject (S0–S4) carries its own real-run verification per
AGENT.md rules: mock-only evidence caps at 2/4, and behavior depending on
Conductor scheduling, Codex/Claude execution, or Linear routing requires a real
run for a passing score.