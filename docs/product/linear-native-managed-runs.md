# Linear-Native Managed Runs

## Purpose

The runtime is a controlled managed run, not a DAG scheduler. One delegated
Linear issue becomes one durable agent run. The agent plans and executes the
work; Conductor owns boundaries, verification, durable state, and Linear
projection.

This replaces graph nodes, mode-capacity scheduling, aggregate parent nodes, and
standalone `plan`/`execute`/`verify` issue projection as product paths.

## Product Model

- One Linear parent issue maps to one managed run.
- The first backend turn produces a bounded plan and does not change files.
- The accepted plan creates one Linear child issue per work item.
- Work-item child issues use the normal Linear lifecycle: Todo, In Progress, In
  Review, Done, or Blocked.
- The managed run advances one dependency-ready work item at a time unless the
  approved plan marks internal backend parallelism as safe.
- Conductor state is authoritative. Agent events are progress signals and never
  decide terminal Linear state.

Linear must answer what was planned, what changed, how it was verified, why the
run is stuck, and what human action is required without requiring local logs.

## Plan Contract

The planning turn returns a structured plan payload:

- `summary`
- `architecture_decisions`
- `work_items`
- `checkpoints`
- `verification_rubric`
- `risks`
- `open_questions`
- `approval_required`

Each work item includes:

- stable `id`
- verb-first single-responsibility `title`
- objective
- slice type
- at most three acceptance criteria
- RED command and GREEN commands
- dependencies
- `estimated_scope` of XS, S, or M
- likely touched files
- parallelization policy
- optional human approval requirement

Conductor rejects plans that are too broad, cyclic, unverifiable, missing file
scope, unsafe to parallelize, or missing Definition-of-Done rubric areas. Plan
validation retries are bounded. If the backend cannot produce a valid plan, the
managed run blocks with a visible reason; if `approval_required` is true, it
records the plan and work items but waits for recorded approval before execution.

The accepted plan is immutable for execution. If implementation needs a new file
scope, dependency, acceptance criterion, or human decision, the backend returns a
plan-revision request. Conductor records a new plan version only after approval
and keeps prior versions for audit.

## Execution Contract

After the plan is accepted, Conductor selects the next dependency-ready work item
and starts one backend turn for exactly that item. The instruction is
scoped to the work item, its likely files, and its RED/GREEN verification.

Work-item transitions are Conductor-owned:

| Phase | Linear State | Managed Run Gate |
|---|---|---|
| Preflight | Todo | plan current, dependencies Done, file scope present |
| Execute | In Progress | backend returns a structured result |
| Review | In Review | file impact, RED/GREEN, acceptance, and secrets checks pass |
| Complete | Done | verified result and summary are published |
| Blocked | Blocked | backend block, verification failure, or human action required |

Scope discipline is enforced by comparing changed files with
`files_likely_touched`. Undeclared file changes fail review unless a plan
revision was requested before the out-of-scope change.

Checkpoint commands run after configured work-item groups. A checkpoint failure
blocks the run even if individual work items passed local checks.

## Result Contract

Each execution turn returns a `WorkItemResult`:

- `work_item_id`
- claimed status: ready for review, blocked, or plan revision requested
- changed files with planned/unplanned classification
- undeclared files
- RED/GREEN test evidence
- acceptance results
- blocked reason or plan revision payload when applicable
- notes

Conductor independently verifies the result before marking the Linear child
issue Done. Failed verification keeps the child issue out of Done and writes the
sanitized reason to Linear and durable state.

## Linear Projection

The parent issue contains the managed run summary block. Each child issue
contains the work-item contract and current managed-run state. The projector writes:

- objective
- acceptance criteria
- likely files
- verification commands
- dependencies
- parallelization policy
- current state and gate status

Only Conductor may transition Linear issues across terminal boundaries. Agent
progress may update non-authoritative narrative fields, but any conflict is
resolved in favor of managed-run state.

Human action is represented as blocked parent or work-item state with a concrete
reason and required action. Local stdout alone is never an operator signal.

## Durable State

Conductor owns managed-run state in its durable run store:

- runs
- plan versions
- work items
- Linear projections
- recovery cursor
- backend thread/session id
- latest sanitized reason

A restarted Conductor resumes from the recovery cursor: verified work items stay
verified, the next non-Done work item is selected, and the backend thread id is
reused when available.

## Backend Boundary

Backends are execution engines. A backend must support:

- plan turn with a structured plan payload
- execution turn with structured `WorkItemResult`
- thread/session continuity
- sanitized event capture for diagnostics in the managed-run attempt view
- no direct Linear writes

Codex planning is Conductor-enforced rather than relying on a product-level
three-mode runtime. Other backends may expose stronger native controls, but the
portable contract is the same managed-run schema and state machine.

## Acceptance

A run is complete only when:

- all work items are Done or explicitly canceled by approved revision;
- checkpoints passed;
- final Definition-of-Done rubric is recorded;
- changed files and verification evidence are visible;
- residual risks are listed;
- Linear parent summary is current;
- no terminal failure is hidden in logs only.

Failures are handled only when the sanitized reason appears in durable state,
operator logs, and the relevant Linear projection.
