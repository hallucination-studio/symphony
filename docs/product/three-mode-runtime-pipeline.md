# Three-Mode Runtime Pipeline

## Status

Product architecture source of truth. Symphony runtime uses the durable
`plan -> execute -> verify` pipeline as scheduling truth. Legacy phase runners,
direct Linear polling, orchestration-run materialized views, and
`performer:phase/*` label projection are removed from product runtime paths and
must not be reintroduced as compatibility surfaces.

Implementation status: the first local/unit implementation includes the
three-mode graph, local verifier, integration queue/conflict handling, runtime
waits, and S4 replan graph rewrite. That local coverage is not final acceptance
evidence. Final acceptance still requires the real acceptance matrix for managed
Podium -> Conductor -> Performer -> Linear runs.

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

## Two Root Causes and the Authority Boundary

Early real runs repeatedly stalled in ways that looked like unrelated bugs — a
downstream node depending on only one of two parallel branches, a replan's new
edges getting overwritten by Linear ingestion, a verifier failing a node on an
exact-text marker the issue never required. These are not separate defects. They
are surface projections of **four independent, deeper root causes** (A–D), and
this document is organized so that every downstream rule traces back to one of
them.

> **Root-cause index.** A — specification vs. proposal (correctness). B —
> topology vs. runtime-state storage (stability). C — graph convergence /
> liveness (the graph must always reach a terminal state). D — capacity single
> source of truth (a pushed policy must be *provably in effect* before acceptance
> asserts on it). A and B were identified first; C and D surfaced once A/B stopped
> masking them.

### Root cause A — specification and proposal were never separated

The system had no deterministic, authoritative representation of **intent** that
exists independently of (a) what the model proposes and (b) what Linear projects.
Because intent was never materialized as a first-class artifact, every component
was forced to *re-derive* intent from an unreliable source: the planner
re-invented the Definition of Done on each run, ingestion re-derived edges from
Linear's lagging view, and the verifier re-derived acceptance criteria from
gates the planning model authored. The model was simultaneously the author of a
proposal and the authority on that proposal.

Contrast with prior art, which all avoid this: Temporal's event history is the
single source of truth and workflow code is deterministic, while LLM calls are
non-deterministic Activities that never define truth; LangGraph fixes topology at
compile time and lets the model only read/route over mutable state; Anthropic's
evaluator-optimizer pattern keeps the loop scaffold and the pass criteria in code,
with the model supplying only content. Symphony was operating as pure
orchestrator-workers (the model dynamically owns everything) on a problem whose
specification is in fact *known* in advance (the business issue, the acceptance
harness, the required parallel shape). The acceptance harness demonstrably knows
the correct graph shape — otherwise it could not assert it — yet that knowledge
lived only in test assertions and was never owned at runtime. That mismatch, not
any individual prompt, is the root cause.

**The fix — IntentSpec as a first-class authority.** Intent is derived
deterministically from the inputs (business issue + acceptance harness / Appendix)
*before* the planner runs, and is authoritative over both the model and Linear:

- The graph-shape constraints (which downstream nodes must depend on which
  parallel branches), the DoD criteria, and the provenance of each acceptance
  check are extracted deterministically and exist prior to any model output.
- The planner's output is demoted to a **proposal**. A deterministic layer
  (`PlanRepair` → `PlanValidator`, see Plan Validation) projects that proposal
  onto the IntentSpec, repairing or rejecting deterministically — never by
  re-invoking the model.
- Gate steps carry a `source` provenance (`issue_requirement`,
  `appendix_harness`, `planner_inferred`, `system_repair`, see Gate step
  provenance); the verifier treats `planner_inferred` steps as
  advisory-conservative so a model-invented check can never manufacture a hard
  failure the issue never asked for.
- Linear can only submit **typed human events** (add/edit `blocks`), never
  replace durable truth (see Ingestion is union-only and idempotent). The durable
  graph is the sole authority; Linear is a projection plus a human-event inbox.

**Where the authority must live (anti-pattern warning).** IntentSpec derivation
and `PlanRepair` are **Conductor-side, plan-commit-time** concerns. They run in
the orchestrator, over structured inputs, *before* the proposal is committed to
the graph. It is an anti-pattern — and the concrete cause of the exact-marker
false-negatives — to derive intent inside the Performer worker *after* the model
has produced output, by regex-scraping the issue prose and matching the model's
own free-text node labels (e.g. keying off the substring `"parallel"` in a title).
That approach is neither deterministic (it depends on model-authored labels) nor
independent (it re-derives intent from prose the model also saw), and it tempts
`PlanRepair` into *injecting* authoritative gate commands the issue never
mandated. Two hard rules follow:

- IntentSpec is derived from **structured issue/harness inputs**, not from
  free-text prose scraping and not from model-authored labels. If a required
  graph shape or gate step cannot be derived structurally, it is absent, not
  guessed.
- `PlanRepair` may **add or re-point `blocks` edges** and may **demote** an
  over-specified model step to `planner_inferred`, but it must **never inject an
  `issue_requirement`/`appendix_harness`/`system_repair` gate command that did not
  come from the IntentSpec**. Repair aligns structure; it does not manufacture
  acceptance authority. Any step repair itself inserts is `system_repair` only
  when it is a structural guard the harness defines, never a content assertion the
  model invented.

### Root cause B — versioned topology and mutable runtime state shared one table

Node runtime state (lifecycle state, `verify_score`, `rework_count`, escalation
reason, attempt pointers) was stored inside the `(graph_revision, node_id)`
rows that version topology. Every new revision therefore had to copy-forward the
live state of every node, and correctness depended on that copy never dropping a
field. Under parallelism — where revisions are minted while executors and
verifiers are mid-flight — this made revision churn the dominant source of lost
or stale state and of scheduling instability. (Symptom 2 above hits *both* root
causes at once: the overwrite is Root cause A, the revision churn it triggers is
Root cause B.)

**The fix — split topology from runtime state** (see State Model, Layer 0):
`graph_revision` versions topology only; runtime state is keyed by `node_id` and
mutated in place, never copied per revision. This mirrors LangGraph's separation
of compiled topology from reduced state, and Temporal's separation of durable
history from live execution.

### Root cause C — the graph had no convergence (liveness) guarantee

Nothing in the scheduler guaranteed a committed graph would ever reach a terminal
state. The state machine permitted a *stable deadlock*: a parent in `REPLANNING`,
one child in `AWAITING_HUMAN`, and a replacement node in `EXECUTING`, with no
force driving it to resolve. `derive_parent_state` computes a display aggregate
but triggers no action; the replan → rework → awaiting-human transitions had no
strictly-decreasing progress measure and no whole-graph terminal assertion. The
acceptance stage `final-pipeline-verified` asserts convergence, but the scheduler
never promised it — a specification requirement with no matching runtime
invariant.

**The fix — an explicit convergence contract** (see Graph Convergence Contract):

- Every graph node has a defined terminal set; a node not in a terminal state
  must have at least one *live driver* (a dispatchable mode, an active attempt, or
  an open human/runtime wait keyed to it). A node with no live driver and no
  terminal state is a **stuck-node** finding, surfaced immediately, never a silent
  stall.
- Every replan/rework strictly decreases a well-founded progress measure
  (bounded `rework_count`/replan depth). Exhausting it escalates to
  `AWAITING_HUMAN(REPLAN_LIMIT_EXCEEDED)` — a terminal-until-resolved state — not
  another loop.
- The parent aggregate is not merely displayed; when all children are terminal the
  parent is *driven* to its aggregate terminal state (`VERIFY_PASSED`, `FAILED`,
  or `AWAITING_HUMAN`), so a fully-terminal child set can never leave the parent
  perpetually `IN_PROGRESS`/`REPLANNING`.

### Root cause D — capacity had no single, verified source of truth

Capacity existed in three representations — the Podium-pushed policy, Conductor's
local default, and the pipeline-view snapshot — with no path that proves a pushed
policy is *in effect*. The local default (`global: null, by_mode: {}`) silently
masks a failed or rejected push: `by_mode: {}` means *no* per-mode cap, so an
observed "2 concurrent executes" can happen because nothing limited it, not
because `execute: 2` took effect. Meanwhile the view reports
`by_mode.get(mode)`, which under the local default disagrees with what the
scheduler actually enforced. Acceptance then asserts on a policy that was never
active.

**The fix — one verified capacity read** (see Scheduling Foundation S0-a):

- The pipeline view reports the **effective policy actually used by the scheduler
  this tick** (its `policy_id` + `version`), not a re-derived limit. View,
  scheduler arithmetic, and enforcement read the same policy object.
- A run whose acceptance depends on a specific pushed policy must observe that the
  active `policy_id`/`version` **matches the pushed one** before asserting on
  per-mode limits. Falling back to local default is a distinguishable, surfaced
  state, not a silent substitute that looks like success.

### Why these are orthogonal

Root cause A is about **where truth comes from** (correctness: authority confusion
among model, Linear, and verifier). B is about **how truth is stored** (stability:
revision churn under concurrency). C is about **whether the system is guaranteed to
make progress** (liveness: no stable deadlock). D is about **trusting the control
inputs** (a pushed policy must be provably in effect). They are fixed by
independent mechanisms and must not be conflated: idempotent ingestion (A) does not
remove the copy-forward hazard (B); splitting the state store (B) does not add a
progress measure (C); a progress measure (C) does not make capacity observable
(D). The invariants and subprojects below are tagged to whichever root cause they
close.

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
13. `graph_revision` versions **topology only** (nodes, parentage, gate bindings,
    `blocks` edges, supersession). Mutable node runtime state (lifecycle state,
    `verify_score`, `rework_count`, escalation reason, attempt pointers) is keyed
    by `node_id` and mutated in place, never copied per revision. No code path may
    copy-forward runtime state on a revision change.
14. A new `graph_revision` is minted only by a plan commit, a replan rewrite, or
    an ingestion that changes topology. Steady-state reconciliation that observes
    no topology change must not mint a revision (revision churn is a bug, not a
    heartbeat).
15. Intent authority is derived Conductor-side at plan-commit time from structured
    inputs, never inside the Performer worker from prose scraping or model-authored
    labels. `PlanRepair` may add/re-point edges and demote steps to
    `planner_inferred`, but must never inject an authoritative gate command absent
    from the IntentSpec. (Root cause A.)
16. Every non-terminal graph node has at least one live driver (a dispatchable
    mode, an active attempt, or an open human/runtime wait keyed to it). A
    non-terminal node with no live driver is a surfaced stuck-node finding, never a
    silent stall. Every replan/rework strictly decreases a well-founded progress
    measure; exhausting it escalates to `AWAITING_HUMAN`, not another loop. (Root
    cause C.)
17. Capacity has one verified source of truth: the pipeline view reports the
    effective policy the scheduler used this tick (`policy_id` + `version`), and a
    run asserting on a pushed policy first confirms the active `policy_id`/`version`
    matches it. Local-default fallback is a distinguishable, surfaced state, not a
    silent substitute. (Root cause D.)

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
(S0-c). The first accepted implementation uses Codex for `plan` and `execute`
and `local-verifier` for `verify`. `local-verifier` is a deterministic verifier
that runs the frozen gate commands against the immutable verification input; it
does not ask the model backend to self-report success. In this first
implementation, local verifier workspace isolation is a disposable worktree plus
mutation detection after gate execution, not OS-level read-only enforcement.
Codex remains eligible for `verify`, but the first-version default is
intentionally non-model verification.

## State Model

The pipeline separates **versioned topology** from **mutable runtime state**, and
tracks three distinct state layers within them. These must not be collapsed —
neither into a single phase enum, nor into a single per-revision node row.
Collapsing either is the primary source of scheduling and replan bugs, and is the
root cause of parallel-execution instability.

### Layer 0: versioned topology vs. mutable runtime state

A `graph_revision` versions **topology only**: which nodes exist, their identity
and parentage, their frozen `gate_snapshot_hash` binding, the `blocks` edges, and
supersession (`superseded_by`). Topology is immutable once a revision is
committed; a new revision is minted only by a plan commit, a replan rewrite, or an
ingestion that genuinely changes topology.

Node **runtime state** — the GraphNode lifecycle state (below), current attempt
pointers, `verify_score`, `rework_count`, and any escalation reason — is keyed by
`node_id` and mutated in place. It is **never** versioned or copied per revision.

Rationale (the root-cause fix): storing runtime state inside
`(graph_revision, node_id)` forces every new revision to copy-forward the live
state of every node, and makes correctness depend on that copy never dropping a
field. Under parallelism — where revisions can be minted while executors and
verifiers are mid-flight — that copy-forward is the dominant source of lost or
stale state and of "the scheduler is too complex to reason about." Keying runtime
state by `node_id` removes the copy-forward contract entirely: a revision change
re-points topology without touching any node's live state, and an attempt started
under revision `N` commits against the same `node_id` regardless of the current
revision.

Fencing consequences:

- A dispatch and its attempt are still stamped with the `graph_revision` and
  `policy_revision` they were planned under.
- An attempt result is fenced by: the attempt still `RUNNING`; its lease token
  still active; its `node_id` not `SUPERSEDED`; and (for execute/verify) the
  node's `gate_snapshot_hash` unchanged. Revision churn that neither supersedes
  the node nor changes its gate does **not** invalidate an in-flight attempt.
- A worker whose `node_id` was superseded by a replan is fenced out, because
  supersession is topology and is visible by `node_id`.

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
    verification_procedure:            # each step carries a provenance tag
      - step: <executable command or explicit step>
        source: issue_requirement | appendix_harness | planner_inferred | system_repair
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

### Gate step provenance

Every verification step is tagged with where its authority comes from. Without
this, a verifier cannot tell an issue-mandated check from a sentence the model
invented, and a plausible-but-wrong `planner_inferred` check (e.g. grepping for an
exact marker string the executor was never told to write) becomes a false-negative
that blocks an otherwise-correct node.

```text
source ∈ {
  issue_requirement,   # traceable to the business issue's own text / acceptance
  appendix_harness,    # mandated by the acceptance harness / Appendix DoD
  planner_inferred,    # the planner's own elaboration; plausible but unmandated
  system_repair,       # inserted by deterministic repair/validation, not the model
}
```

Verifier obligations by source:

- `issue_requirement` / `appendix_harness` / `system_repair` steps are
  **authoritative**: failing them fails the node.
- `planner_inferred` steps are **advisory-conservative**: a `planner_inferred`
  step must not, on its own, drive a node below `pass_threshold`. In particular,
  an inferred exact-text/marker match that is not derivable from the issue text
  cannot be the sole reason a node fails. It may lower confidence (contribute to a
  2 vs 3 within already-satisfied authoritative checks) but cannot manufacture a
  hard failure the issue never asked for.
- A gate with **no** authoritative step is invalid (see PlanValidator); a node
  cannot be gated entirely by inference.

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

1. create a fresh, disposable worktree/workspace;
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

First implementation note: `local-verifier` creates a disposable worktree and
uses mutation detection after running gate commands. This catches gate procedures
that write implementation artifacts, while preserving common test cache behavior
that the verifier explicitly ignores. It should not be described as OS-level
read-only enforcement unless a later implementation adds that capability.

## Runtime Permission Boundaries

Isolation includes capability limits, not just separate homes.

- **Planner**: may propose graph/gate (proposal only); cannot run
  implementation; cannot write verify verdicts.
- **Executor**: may modify code, produce patches, upload evidence; cannot mutate
  frozen gates; cannot write verify verdicts.
- **Verifier**: disposable worktree/workspace with mutation detection; may run
  tests and read artifacts; cannot push commits, cannot modify task content
  except writing the verdict via Conductor API, cannot change gates or the
  dependency graph, cannot produce rework patches.

## Backend Abstraction

Backends differ in capability, so the scheduler and mode lifecycle must depend only
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
Scheduler and mode lifecycle logic must not embed backend-specific behavior.

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

### Ingestion is union-only and idempotent

Linear is written *after* it is read within a coordination pass, so the remote
`blocks` view a reconcile observes always lags Conductor's own graph. Treating
that lagging remote view as authoritative — in particular, treating "an edge
Conductor knows about but Linear has not echoed back yet" as a deletion — makes
ingestion delete live edges and mint a fresh `graph_revision` on nearly every
tick. Under parallelism that revision churn is the dominant cause of scheduling
instability.

Ingestion is therefore defined as a **union of remote-added edges with current
non-superseded local edges**, minus edges touching `SUPERSEDED` nodes:

- start from the current local `blocks` edges whose endpoints are both live
  (not `SUPERSEDED`);
- add any new edges the human created in Linear;
- drop any edge whose endpoint is `SUPERSEDED` (those belong to replaced topology);
- the result must pass `PlanValidator` (acyclic, legal directions, computable
  entry/exit) before it can commit.

Consequences that must hold:

- **Idempotence:** if the merged edge set equals the current edge set, ingestion
  commits nothing and mints no revision. Steady-state reconciliation is a no-op.
- **No silent deletion via lag:** a local edge Linear has not yet echoed is never
  removed by ingestion. Deleting an edge is a topology change and is expressed
  only through a replan / new graph-revision proposal, never inferred from a
  lagging remote read.
- **Bounded growth:** because edges touching superseded nodes are filtered, and
  because a valid DAG bounds the edge set, union-only ingestion cannot grow the
  graph unboundedly across ticks.

This is deliberately the simplest rule that is safe under lag: additive, filtered
by supersession, validated before commit, and a no-op in steady state.

## Plan Validation

The planner has broad authority (it authors the DAG, gates, and rubrics), but its
raw output is a **proposal, never product fact**. Real model output varies run to
run: it may make a downstream node depend on only one of two parallel branches,
may drop a replacement subgraph's inherited downstream edge, or may invent an
exact-text gate the issue never required. The prompt is allowed to *suggest*
shape; it is never allowed to *own* Definition-of-Done compliance.

Compliance is therefore enforced by two deterministic, non-LLM stages before any
commit: `planner output → PlanRepair → PlanValidator → commit graph`.

### PlanRepair (deterministic normalization)

`PlanRepair` runs first and deterministically rewrites the proposal to satisfy
structural DoD constraints the model is unreliable at. Repairs it performs are
stamped `system_repair` (edges) or as `system_repair`-sourced gate steps, so they
are auditable and distinguishable from model output:

- **Parallel-dependency shape.** If the issue's DoD requires a downstream node to
  depend on *all* sibling parallel branches, and the proposal wires it to only a
  subset, repair adds the missing `blocks` edges so the downstream depends on the
  full parallel set. A downstream must not become `READY` while any required
  sibling is still executing, failed, or replanning.
- **Gate over-specification.** Repair strips or downgrades gate steps that assert
  exact text / markers not derivable from the issue text. For a shared-file
  conflict scenario, the repaired gate verifies *the shared file exists and the
  patch diff is non-empty*, not that the executor wrote a planner-invented
  sentence. Removed assertions, if kept at all, are demoted to `planner_inferred`
  (advisory-conservative per Gate step provenance).

`PlanRepair` is idempotent and total: repairing an already-compliant proposal is a
no-op, and every repair either succeeds deterministically or the proposal is
rejected — repair never depends on re-invoking the model.

### PlanValidator (deterministic rejection)

The validator runs after repair and rejects a plan unless:

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
10. no gate requires credentials the verifier cannot access;
11. every gate has at least one **authoritative** step (`issue_requirement`,
    `appendix_harness`, or `system_repair`); a gate composed only of
    `planner_inferred` steps is rejected;
12. required parallel-dependency shape holds after repair (a downstream that must
    depend on all sibling parallel branches actually does);
13. every gate step carries a valid `source` provenance tag.

Validation failures are structural facts, not model opinions: the same proposal
always fails the same way, and a failing proposal never reaches the scheduler.

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
- The current local/unit implementation includes the `REPLANNING` back-edge from
  S4. It still needs real acceptance matrix coverage before being treated as
  fully accepted product behavior.
- `AWAITING_HUMAN` is reachable from any state on escalation (see Human
  Escalation).

## Graph Convergence Contract

A committed graph must be *guaranteed* to reach a terminal state; the scheduler
may not permit a stable deadlock (Root cause C). This contract makes convergence a
runtime invariant, not merely an acceptance hope.

### Terminal states and live drivers

Terminal node states are `VERIFY_PASSED`, `FAILED`, `SUPERSEDED`, and
`AWAITING_HUMAN` (terminal-until-resolved). Every node **not** in a terminal state
must have at least one **live driver**:

- a mode for which it is currently dispatchable (`READY`/`REWORKING` with
  satisfied dependencies and capacity), or
- an active attempt (an unexpired lease + `RUNNING` attempt), or
- an open human wait or runtime wait keyed to that node.

A non-terminal node with no live driver is a **stuck-node finding**. Conductor
surfaces it in reconcile findings each tick and escalates it to
`AWAITING_HUMAN(<structured reason>)` rather than leaving it silently parked. "The
graph stopped moving but nothing is wrong" is not a permitted state.

### Well-founded progress measure

Every backward transition consumes a bounded budget so loops cannot run forever:

- `rework_count` is bounded by `max_rework_attempts`; reaching it moves the node to
  `REPLANNING`, not another `REWORKING` cycle.
- replan depth is bounded; a replan whose subgraph itself exhausts the budget, or
  fails validation, escalates to `AWAITING_HUMAN(REPLAN_LIMIT_EXCEEDED)`.
- Because `SUPERSEDED` is terminal and replan strictly increases replan depth, the
  `(replan_depth, rework_count)` pair is a well-founded measure that strictly
  decreases the remaining budget on every backward edge.

### Parent aggregate is driven, not just displayed

`derive_parent_state` computes the aggregate, but the coordinator must also *act*
on it: when every child of a parent is terminal, the parent is driven to its
aggregate terminal state (`VERIFY_PASSED` if all exit children passed and all
children are `VERIFY_PASSED`/`SUPERSEDED`; `AWAITING_HUMAN` if any child awaits a
human; `FAILED` if any child is unrecoverably failed). A fully-terminal child set
may never leave the parent perpetually `IN_PROGRESS` or `REPLANNING`. This is the
transition that lets `final-pipeline-verified` actually converge.

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

**Single verified source of truth (Root cause D).** Capacity must never be
readable in a way that disagrees with what the scheduler enforced:

- The scheduler arithmetic (`remaining_for_mode`), the enforcement in
  `start_due_attempts`, and the `/api/v1/pipeline` view all read the **same**
  active policy object. The view reports that policy's `policy_id` + `version` and
  the per-mode limit *as the scheduler saw it this tick*, never a separately
  re-derived number.
- Local-default fallback (`global: null, by_mode: {}`) is a **distinguishable,
  surfaced state**, not a silent substitute. The view exposes whether the active
  policy is a Podium-pushed policy or the local default, so an acceptance run can
  tell "policy in effect" from "push never landed."
- A run whose acceptance asserts a specific per-mode limit (e.g.
  `execute: 2`) must first confirm the active `policy_id`/`version` matches the
  pushed policy. Observing N concurrent attempts under the local default (which
  imposes no per-mode cap) is **not** evidence the pushed limit took effect.

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
- The runtime profile carries the **backend selection** and sanitized
  backend-specific settings per mode.
- Runtime-profile push and scheduler-policy push share the same Podium →
  Conductor configuration channel.

**Preserved discipline:** documentation-first posture; docs must not claim mode
isolation shipped unless the runtime-profile materialization, managed
environment filtering, per-mode `CODEX_HOME`, and fail-closed setup all land in
the same change.

## Failure-Driven Re-Decomposition (S4, ADaPT)

S4 local/unit implementation is present: verify failure at the rework limit moves
a node to `REPLANNING`, a replanning attempt receives failure context, and a
validated replacement subgraph atomically supersedes and rewires the failed node.
This is not final acceptance evidence; the real acceptance matrix must still
cover the managed replan scenario with real runtime, Linear projection, logs, and
evidence artifacts.

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
   (GraphNode / Attempt / Aggregate) over a **topology-vs-runtime-state split**
   (revision-versioned topology; `node_id`-keyed mutable runtime state), graph
   store, VerificationInputSnapshot, TaskOutputManifest schema, and
   plan→execute→verify flow (closes Root cause B)
        │
S2 Planner mode — gate planner becomes an execution decomposer: subtasks +
   blocks + pre-frozen GateSpecSnapshot per subtask. A deterministic IntentSpec is
   derived from the issue + acceptance harness *before* the model runs; the model
   output is a proposal that passes PlanRepair (deterministic normalization onto
   IntentSpec) then PlanValidator; committed as a graph revision and projected to
   Linear (closes Root cause A)
        │
S3 Verifier mode — isolated runtime executing gates against Verification Input
   Snapshots, scoring 0–4; enable verify-passed as the dependency predicate
   (depends on S0-c per-mode isolation and S0-b predicate hook)
        │
S4 ADaPT failure-driven re-decomposition (REPLANNING + atomic graph rewrite;
   local/unit implementation present, real acceptance matrix still required)
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
- **Replaces:** legacy Linear acceptance semantics with pre-frozen gate
  snapshots, isolated verifier attempts, verified manifests, and deterministic
  integration.
- **Demotes:** `docs/product/symphony-linear-tree-skill.md` to the optional S5
  importer role.

Supporting docs must stay aligned to the per-mode isolated `CODEX_HOME`
invariant and the request/result based Performer CLI.

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
   Input Snapshot. The first `local-verifier` implementation uses a disposable
   worktree and mutation detection rather than filesystem write prevention;
   it cannot mutate gates or write implementation artifacts without being
   detected and failed.
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
   scheduler or mode lifecycle logic.
11. Abnormal conditions escalate to `AWAITING_HUMAN` with a structured reason
    rather than collapsing into `FAILED`.
12. Linear projection exposes operator-visible pipeline status, including
    `operator_status` on every projected node and `operator_wait_kind` whenever
    Codex/runtime is waiting for approval, permission, or tool input.
13. Every committed graph converges: no non-terminal node lacks a live driver, and
    a parent whose children are all terminal is driven to its aggregate terminal
    state rather than parked in `IN_PROGRESS`/`REPLANNING` (Root cause C).
14. Capacity is reported from the single active policy the scheduler used, with
    Podium-pushed vs. local-default distinguishable; acceptance confirms the pushed
    `policy_id`/`version` is active before asserting per-mode limits (Root cause D).

## Verification

Documentation-consistency and symbol-existence checks:

```bash
grep -Rni "CODEX_HOME\|~/.codex\|managed mode\|runtime profile" \
  docs README.md AGENT.md

grep -Rni "SchedulerPolicy\|global_capacity\|is_dispatchable\|readiness_counts\|by_mode" \
  packages/conductor/src/conductor

grep -Rni "RuntimeConfigEnvelope\|RuntimeProfile\|CODEX_HOME\|attempt_request_path\|attempt_result_path\|PipelineView" \
  packages
```

Each implementation subproject (S0–S4) carries its own real-run verification per
AGENT.md rules: mock-only evidence caps at 2/4, and behavior depending on
Conductor scheduling, Codex/Claude execution, or Linear routing requires a real
run for a passing score.

---

# Appendix: Definition of Done per Feature

> **Purpose.** The body of this RFC defines *what* to build. This appendix defines
> *how far* each feature must go before it is considered finished, so a feature is
> not re-opened round after round. It is additive: it does not change any decision
> above.
>
> **How to read it.** Each feature has a **Final shape** (the end state, no further
> evolution expected) and three completeness bars that must be cleared *in order*:
>
> - **L (Local):** in-process / unit / sqlite-level behavior is correct and tested
>   with `make test`. Per AGENT.md this caps at **2/4** on its own.
> - **R (Real):** exercised through a real managed run
>   (Podium → Conductor → Performer → Linear), or real Codex/Claude where the mode
>   runs a model, with evidence per AGENT.md. This is the bar for **3–4/4**.
> - **H (Hardened):** the failure/adversarial/concurrent edge cases that make the
>   feature safe to depend on are closed, not just the happy path.
>
> A feature is **Done** only at **R + H**. `L` alone is explicitly *not* done.
> "Current" notes reflect the code state observed when this appendix was written
> and may advance; treat the bars, not the notes, as the contract.

## Legend for current state

- **present-local** — implemented and unit-covered locally; R/H still open.
- **present-partial** — some of the final shape exists; specific gaps listed.
- **scaffolded** — types/hooks exist but behavior is not the final shape.

---

## S0-a — Typed capacity + versioned Podium-pushed policy

**Final shape.** `SchedulerPolicy` carries `global` plus `by_mode` limits
(`plan`, `execute`, `verify`), where `execute: null` means no mode-local cap but
still bounded by `global`. Podium owns the policy per runtime group, pushes it
over `POST /api/v1/runtime/config`, and Conductor accepts only strictly
increasing `version`, persists the active policy, and keeps a local default when
Podium is unreachable. Capacity is accounted by live **leases**, not by process
guesses.

- **L done when:** `remaining_capacity` respects `global` + each `by_mode`; the
  `null`-means-no-local-cap arithmetic is unit-tested; a lower/equal `version` is
  rejected (`409 stale_runtime_config`); lease acquire/heartbeat/expiry/reclaim
  and `validate_fencing_token` are unit-tested.
- **R done when:** a real managed run with ≥2 modes active shows Conductor pulling
  a Podium-pushed policy, enforcing per-mode limits under real dispatch, and
  surviving a Podium-unreachable window on local defaults.
- **H done when:** stale/out-of-order policy pushes never lower the active
  version; a policy that lowers a limit below current active count stops *new*
  dispatch without preempting in-flight work; a crashed worker's lease expires and
  capacity is reclaimed with no double-count and no leak.
- **Current:** present-partial. Config channel + version rejection + lease/fencing
  present-local; `by_mode` enforcement and the Podium-unreachable fallback need R
  evidence.

## S0-b — Dependency-satisfaction predicate + pipeline observability

**Final shape.** Dispatchability consults a pluggable
`DependencySatisfactionPolicy`. Pre-S3 default: a blocker is satisfied at terminal
success. From S3: a blocker is satisfied only at `VERIFY_PASSED` with
`score >= 3`. Linear `blocks` remains a hard precondition. Podium exposes a
**read-only** pipeline view: per-mode active/limit/queued, which nodes are in
plan/execute/verify, and a **conditional** predicted call order that always
carries its `prediction_basis` (`graph_revision`, `policy_revision`,
`assumption: unknown verifies pass`, `generated_at`) and per-node
`confidence: conditional`.

- **L done when:** the predicate is swappable and unit-tested for both variants;
  `blocks` precondition holds; predicted-order simulation is deterministic for a
  fixed graph+policy and always emits `prediction_basis`.
- **R done when:** the Podium `/api/v1/pipeline` view reflects a real run's live
  per-mode detail, and the predicted order visibly re-computes as nodes complete.
- **H done when:** the predicted order is never presented as a commitment (basis +
  conditional confidence always attached); a mid-flight graph rewrite (S4) or new
  `blocks` edge refreshes the view without stale ordering; the view is strictly
  read-only (no scheduling side effects).
- **Current:** present-partial. Predicate hook + `/api/v1/pipeline` route
  present-local; R evidence of live refresh and conditional framing pending.

## S0-c — Runtime profile + per-mode CODEX_HOME isolation + pluggable backend

**Final shape.** Podium owns the managed runtime profile; Conductor materializes a
**per-mode** isolated `CODEX_HOME` (and equivalent home for other backends) under
instance state, never the operator's global `~/.codex`. The runtime profile
selects the backend per mode via a `RuntimeBackendRegistry`; scheduler and mode
lifecycle logic contain no backend-specific branches. A backend that cannot meet a
mode's `ModeRequirement` is ineligible for that mode.

- **L done when:** each mode resolves to its own `runtime-homes/<mode>/…` home;
  materialization fails loudly if the home cannot be created; a seed source that
  points at the default user `.codex` is rejected; backend eligibility per mode is
  unit-tested; registry selection is unit-tested.
- **R done when:** a real managed run shows plan/execute/verify each running under
  distinct `CODEX_HOME` paths with no cross-mode leakage, and a non-Codex backend
  (e.g. Claude) can be selected for at least one mode without touching scheduler
  or phase code.
- **H done when:** managed mode provably never falls back to `~/.codex` (negative
  test); a mode assigned an ineligible backend is refused before dispatch, not
  mid-run; per-mode homes are not shared even under concurrent same-issue runs.
- **Current:** present-partial. Per-mode home materialization + registry +
  eligibility present-local; second real backend (Claude) and the negative
  no-fallback R/H evidence pending.

## S1 — Three-layer state model + graph store + artifact model

**Final shape.** Topology and runtime state are stored separately.
`graph_revision` versions **topology only** (node identity/parentage, gate
bindings, `blocks` edges, supersession); a `node_id`-keyed runtime-state store
holds the mutable GraphNode lifecycle state, `verify_score`, `rework_count`,
escalation reason, and attempt pointers, mutated in place and never copied per
revision. Over that split sit three distinct layers: **GraphNode** state,
**Attempt** state (execute and verify attempts stored separately and immutable
once terminal), and **derived Aggregate parent** state (`IN_PROGRESS` is derived,
never authored; a parent reaches `VERIFY_PASSED` only via child aggregation).
`ConductorPipelineStore` is the durable graph with `graph_revision` stamping.
`VerificationInputSnapshot` and `TaskOutputManifest` schemas exist and are bound
to attempts/gates by id and hash.

- **L done when:** node/attempt/aggregate transitions are enforced (illegal
  transitions rejected); parent state is computed only by aggregation and cannot
  be written directly; runtime state is keyed by `node_id` and a revision change
  performs **no** copy-forward of runtime state (asserted by test); every dispatch
  is stamped with `graph_revision` + `policy_revision`; snapshot/manifest
  round-trip is unit-tested.
- **R done when:** a real decomposed issue shows the parent reaching
  `VERIFY_PASSED` strictly from child aggregation, with attempts recorded per node
  across a real run, and node runtime state surviving intervening revision changes
  without loss.
- **H done when:** results stamped with a superseded `graph_revision` cannot commit
  only when the node itself is superseded or its gate changed (a benign revision
  bump that leaves the node and gate intact does not fence an in-flight attempt);
  terminal attempts are immutable; a parent with a failed/awaiting child never
  shows a passing aggregate.
- **Current:** present-partial. Store, three layers, revision stamping, snapshots
  present; the topology/runtime-state split, the no-copy-forward guarantee, R
  aggregation evidence, and revision-churn survival (H) pending.

## S2 — Planner mode + IntentSpec + PlanRepair + PlanValidator + Linear projection

**Final shape.** A deterministic **IntentSpec** is derived from the business issue
and the acceptance harness/Appendix *before* the model runs, capturing the
required graph-shape constraints, DoD criteria, and the provenance of each
acceptance check. `performer --mode plan` then proposes a `blocks` DAG where
**every** subtask carries a pre-frozen `GateSpecSnapshot` (rubric 0–4,
`pass_threshold = 3` recorded for audit, not overridable) and every gate step
carries a `source` provenance. The proposal is treated as a proposal, not fact:
it is committed **only** after `PlanRepair` (deterministic normalization onto the
IntentSpec) and then a deterministic, non-LLM `PlanValidator` pass all checks. The
committed graph is projected to Linear as parent/child issues with `blocks`, each
stamped with `symphony` metadata (`graph_id`, `node_id`, `plan_attempt_id`,
`gate_snapshot_hash`, `conductor_revision`). Planner cannot run implementation or
write verdicts. (This subproject closes Root cause A.)

- **L done when:** IntentSpec derivation is deterministic and unit-tested;
  PlanRepair is idempotent and total (repairs parallel-dependency shape; strips /
  demotes to `planner_inferred` any exact-text gate step not derivable from the
  issue); PlanValidator rejects: missing gate, non-executable gate, incomplete
  0–4 rubric, lowered/absent threshold, dependency cycle, illegal `blocks`
  direction, uncomputable entry/exit, subtask count over policy limit, gate
  needing executor-only state, gate needing verifier-inaccessible creds, a gate
  with no authoritative step, and a required parallel-dependency shape not holding
  after repair; gate hashing/freezing and step provenance are unit-tested.
- **R done when:** a real business issue is decomposed by a real model, is
  normalized by PlanRepair against the IntentSpec, passes PlanValidator, commits a
  graph revision, and projects a correct parent/child+`blocks` tree to real Linear
  with explicit `parent` fields — with the committed shape matching the IntentSpec
  regardless of model variation.
- **H done when:** a malformed model proposal never reaches the scheduler; a model
  proposal that violates the required parallel-dependency shape is deterministically
  repaired, not committed as-is; a model-invented exact-text check cannot on its
  own fail an otherwise-correct node (verified end-to-end via provenance); a re-run
  over the same issue is idempotent in Linear (no duplicate issues/edges); gate
  content cannot be mutated post-freeze via any path.
- **Current:** present-partial. Plan mode + validator + gate snapshots
  present-local; IntentSpec derivation, PlanRepair normalization, and step
  provenance landing; real-model decomposition and Linear-tree R evidence +
  shape-repair/provenance H pending.

## S3 — Verifier mode (isolated) + verify-passed dependency gating

**Final shape.** `performer --mode verify` runs in an **isolated** runtime against
an immutable `VerificationInputSnapshot`. Canonical path: fresh disposable
workspace → checkout `base_revision` → fetch `patch_uri` and verify `patch_hash` →
apply patch → assert resulting tree == `expected_result_tree` → pull hash-checked
read-only artifacts → load frozen gate by hash → run the gate procedure → emit a
0–4 verdict via Conductor API. Direct checkout of `result_revision` as the primary
path is forbidden. Verifier cannot push commits, mutate gates, change the graph,
or produce rework patches. On pass (`>= 3`), Conductor publishes the
`TaskOutputManifest`; downstream gating switches to verify-passed.

- **L done when:** verify attempt requires a frozen gate + verification input
  (rejects otherwise); apply-patch path + tree-hash assertion + artifact-hash
  checks are unit-tested; verdict scoring maps to the calibrated rubric;
  `score == 2` does not satisfy dependents.
- **R done when:** a real run verifies a real executor patch in an isolated
  worktree/home distinct from the executor's, scores against the frozen gate, and
  a real downstream node dispatches only after upstream `VERIFY_PASSED >= 3`.
- **H done when:** the `local-verifier` mutation-detection reliably **fails** a run
  where the verifier environment alters tracked state (self-report / tampering is
  caught, not trusted); a patch whose applied tree ≠ `expected_result_tree` is
  rejected; a verdict written under an expired lease/fencing token is refused.
- **Current:** present-partial. Verify mode + frozen-gate/input requirement +
  local-verifier home present-local; R isolation evidence and mutation-detection
  failure H are the critical remaining bars.

## S4 — Failure-driven re-decomposition (REPLANNING + atomic graph rewrite)

**Final shape.** On verify failure a node enters `REWORKING`; when rework is
exhausted it enters `REPLANNING`, which produces a PlanValidator-passed subgraph
that **replaces** the failing node atomically as a new `graph_revision`: the old
node → `SUPERSEDED`; upstream blockers reconnect to subgraph entry nodes;
downstream dependents reconnect to subgraph exit nodes; a dependent dispatches only
when all exit nodes are `VERIFY_PASSED`. The scheduler only ever schedules the
current active revision.

- **L done when:** the rewrite is atomic (single new revision, no intermediate
  detached state); edge reconnection follows the `A blocks T1 … T2 blocks B`
  invariant; superseded nodes are never re-dispatched; unit-tested.
- **R done when:** a real failing node is replanned into a working subgraph within
  a real run, and the previously-blocked downstream eventually dispatches only
  after the subgraph's exits pass.
- **H done when:** a worker still running against the superseded revision cannot
  commit (revision fencing); no dependent is ever dispatchable against the old
  node after rewrite; a replan that itself fails validation escalates to
  `AWAITING_HUMAN(REPLAN_LIMIT_EXCEEDED)` rather than looping or `FAILED`.
- **Current:** present-partial. Replan rewrite present-local; real replan loop and
  revision-fencing H pending.

## Patch Integration and Conflict Model

**Final shape.** Each execute attempt runs against a computed input baseline:
entry nodes use the graph base revision; dependent nodes use the integrated result
of verified blockers (or explicitly named verified output manifests).
Independently verified patches are **not** treated as globally integrated;
Conductor owns a deterministic integration step/queue. Conflicting verified patches
escalate to `AWAITING_HUMAN` or `REPLANNING` rather than silently merging. A full
merge engine is *not* required in the first implementation, but the boundary
("`VERIFY_PASSED` on parallel nodes ≠ globally integrated state") must hold.

- **L done when:** baseline computation is deterministic and unit-tested; a
  synthetic conflict between two verified patches is detected and escalated, not
  merged.
- **R done when:** a real run with two parallel executors touching overlapping
  files reaches a defined outcome (integrated or escalated), never a silent
  last-writer-wins.
- **H done when:** conflict escalation is reproducible under real concurrency; a
  downstream node never consumes an un-integrated upstream output; if a future
  integration queue is added it uses its own attempt/state records without
  changing the plan/execute/verify contract.
- **Current:** present-partial. Integration/conflict handling present-local;
  real-concurrency R evidence pending.

## Human Escalation

**Final shape.** Abnormal conditions escalate to `AWAITING_HUMAN` with a structured
reason (`PLAN_INVALID`, `GATE_UNEXECUTABLE`, `LINEAR_SYNC_CONFLICT`,
`CREDENTIAL_REQUIRED`, `REPLAN_LIMIT_EXCEEDED`, `BACKEND_UNAVAILABLE`,
`CAPACITY_STARVED`), never a silent collapse into `FAILED`. Per AGENT.md, human
intervention uses a Linear `[Human Action]` child issue; the human completing that
issue is what resumes the affected node.

- **L done when:** each reason is reachable and unit-tested; escalation does not
  mark the node `FAILED`.
- **R done when:** a real escalation creates the `[Human Action]` child, the parent
  goes `blocked`, and completing the child resumes exactly that node.
- **H done when:** parent comments / command-like comments never resume work (only
  the completed child issue does); an unresolved escalation is surfaced by
  reconcile findings rather than silently stalling.
- **Current:** present-partial. Reasons + AWAITING_HUMAN present-local; the real
  child-issue resume loop is the key R bar.

## Linear projection (operator visibility)

**Final shape.** Every projected node carries `operator_status`, and
`operator_wait_kind` is set whenever Codex/runtime is waiting on approval,
permission, or tool input. Linear is a projection/collaboration surface only;
Conductor's graph remains scheduling truth. Human edits that would mutate frozen
gates, historical attempts, or past graph revisions are rejected or converted into
a new graph-revision proposal.

- **L done when:** projection payloads always include `operator_status`, and
  `operator_wait_kind` is populated for wait states; idempotent write keys are
  unit-tested.
- **R done when:** a real run shows operators the live wait/pipeline status on the
  Linear issues, matching Conductor state.
- **H done when:** a human editing a gate/description in Linear cannot alter the
  authoritative snapshot; reconciliation ingests legitimate `blocks` edits without
  letting Linear become a second source of scheduling truth; ingestion is
  union-only and idempotent — a lagging remote read never deletes a live local
  edge, and a steady-state pass (no topology change) mints no `graph_revision`.
- **Current:** present-partial. `operator_status`/`operator_wait_kind` fields exist
  (low footprint); union-only idempotent ingestion landing; R operator-visibility
  evidence and edit-rejection H pending.

---

## Acceptance: composable sub-scenarios before the overall run

A single scenario that exercises S0–S4 + Patch + Human + Linear projection at once
means any one broken sub-behavior forces a full, expensive real-Codex re-run to
re-observe. Worse, several early runs reported `failures=[]` while a manual look at
the committed graph showed the shape was wrong — the run passed hundreds of checks
before anyone noticed the topology never satisfied the DoD.

Acceptance is therefore split into **focused sub-scenarios** that can be run and
scored independently, plus one final overall smoke. Each sub-scenario targets one
mechanism and traces to a root cause:

- **parallel-dependency-shape** (Root cause A): a downstream node depends on *all*
  required parallel branches after PlanRepair; it never becomes `READY` while any
  required sibling is still active.
- **replan-edge-inheritance** (Root cause A + B): after a replan, the replacement
  subgraph's exits inherit the superseded node's downstream edges, and a later
  ingestion pass does not overwrite them.
- **linear-block-ingestion** (Root cause A): union-only, idempotent; a lagging
  remote read never deletes a live local edge; a no-topology-change pass mints no
  revision.
- **gate-normalization** (Root cause A): a model-invented exact-text gate step is
  stripped or demoted to `planner_inferred` and cannot alone fail a correct node.
- **runtime-wait**: a Codex/runtime wait surfaces as `operator_wait_kind` and
  resumes correctly.
- **integration-conflict**: two overlapping verified patches reach a defined
  outcome (integrated or escalated), never silent last-writer-wins.

**Fail-fast checkpoints.** Every DoD-critical *shape* is asserted at the earliest
possible checkpoint, not after the full pipeline drains. In particular, the
committed graph's `blocks` shape and gate-step provenance are asserted immediately
after plan commit (before any executor dispatch), and `/api/v1/pipeline` exposes
the committed `blocks` edges so acceptance can inspect the graph directly. A shape
that violates the IntentSpec aborts the scenario at the checkpoint rather than
after hundreds of downstream checks. A reported `failures=[]` is only trusted when
the shape checkpoints have themselves been asserted.

## Overall exit bar

The pipeline is **product-complete** only when every feature above is at **R + H**,
and every sub-scenario above passes, demonstrated by a single real managed
acceptance run (Podium → Conductor → Performer → Linear) in which:

1. a real business issue is decomposed, PlanValidated, committed as a graph
   revision, and projected as a correct `blocks` tree in Linear;
2. executors run in parallel under per-mode Podium-pushed capacity, with leases and
   fencing observed;
3. verification runs isolated, apply-patch canonical, mutation detection proven to
   fail tampering, and downstream gates only on `VERIFY_PASSED >= 3`;
4. at least one induced failure is replanned into a working subgraph, or escalates
   to a structured `AWAITING_HUMAN` that a human resumes via the child issue;
5. parallel-conflict is either integrated or escalated, never silently merged;
6. the Podium pipeline view shows live per-mode detail and a conditional predicted
   order with its basis;
7. no managed run touches the operator's global `~/.codex`;
8. the AGENT.md reconcile findings are all clean and the evidence bundle scores
   each requirement per the 0–4 rubric with no item above its hard cap.

Until that run exists, local/unit coverage for any feature is at most **2/4** and
the feature is **not** Done regardless of how complete it looks locally.
