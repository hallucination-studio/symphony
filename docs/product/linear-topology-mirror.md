# Linear Topology Mirror

## Status

Design supplement to `three-mode-runtime-pipeline.md`. Initial local/unit
implementation is present. This document **evolves** several invariants in that RFC; where the
two disagree, the specific evolutions listed under "Invariants this document
changes" win, and everything else in the base RFC still holds.

The base RFC's authority boundary is unchanged and remains the foundation:
**Conductor's durable graph is the single scheduling source of truth; Linear is a
projection and human-event inbox.** This document does not move scheduling
authority into Linear. It changes *how completely and faithfully* the graph is
projected, so that "which nodes ran, which failed, which need a human" is fully
visible on Linear without the projection and the internal state drifting apart.

## Problem

Operators cannot see execution reality on Linear. Two concrete gaps:

1. **Attempts are invisible.** A node accumulates plan/execute/verify attempts in
   Conductor's `attempts` table (`AttemptRecord`, carrying `attempt_id`,
   `thread_id`, `state`, `error`, `score`), but **none of that is projected to
   Linear**. An operator looking at a Linear issue cannot tell whether execute
   ran, crashed, or was never dispatched.
2. **Human-required and reworked/replanned state is projected inconsistently.**
   Human waits become separate `[Human Action]` child issues, rework happens
   in-place invisibly, and replan rewrites the internal graph without a legible
   Linear trail. The result is a Linear view that disagrees with internal state.

The goal is a **faithful, append-only mirror of the execution topology** on
Linear: one DAG node = one sub-issue (nestable to arbitrary depth), every attempt
written back as a status-bearing comment, and human intervention handled in place
on the affected node.

## Model

Four pillars.

### 1. sub-issue = graph node (nestable to any depth)

A Linear sub-issue corresponds to exactly one `GraphNode`. `blocks` relations
between issues are the DAG scheduling dependencies (unchanged from the base RFC:
Invariant 6, dependency satisfaction = upstream `VERIFY_PASSED`). Parent/child
nesting expresses decomposition/ownership and may nest to arbitrary depth; a node
decomposed into a subgraph projects that subgraph as child issues of the node.

The node's **lifecycle state is the issue's state**. The Linear workflow state
stays coarse (In Progress / Done / Canceled / a blocked-style state for
`need_human`); fine-grained plan/execute/verify progress lives in comments and in
the projection's `operator_status`/`operator_wait_kind` fields (base RFC
Invariant 12), never encoded into the Linear workflow state.

### 2. root issue is immutable

The business root issue represents the original delegated intent and is never
rewritten. It is a parent/aggregate node — never dispatched to execute — and
reaches its aggregate terminal state only through child aggregation (base RFC
"Aggregate parent state"). This is unchanged; it is stated here because the
supersede chain (pillar 4) grows *beside* the root, never mutates it.

### 3. same-stage retry = comment + state transition only (bounded)

A retry **within the same stage** — the target and the frozen gate are unchanged,
the previous attempt died on a process crash, timeout, or environment flake — does
**not** create a new issue. It is a new `AttemptRecord` on the same node,
projected as a new status-bearing comment on the same issue.

Same-stage retry is bounded. When the bound is reached, the node transitions to
`need_human` (see pillar 4 / Human handling) rather than retrying forever. This
preserves the base RFC's convergence guarantee (Root cause C): every backward edge
consumes a bounded budget, and exhaustion escalates to a human, never another
loop.

### 4. cross-stage regression = cancel old node + new node (supersede chain)

A regression that moves **to an earlier stage** — canonically, `verify` judges the
approach itself wrong and work must return to `plan` — does **not** mutate the node
in place. Instead:

1. the old node's issue is **Canceled** (node → `SUPERSEDED`);
2. a **new issue** (new node) is created at the **same level** (same parent) as the
   old one;
3. the new node **inherits the old node's `blocks` edges**: everything that blocked
   the old node now blocks the new node, and everything the old node blocked is now
   blocked by the new node;
4. the new issue carries a `replaced-by`/`replaces` reference to the old issue, plus
   the "what to change" context that drove the regression;
5. the rewrite commits atomically as a new `graph_revision`.

This is the base RFC's **replan graph-rewrite invariant**, made visible on Linear
as an append-only issue chain. The internal mechanics (SUPERSEDED, atomic revision,
edge reconnection, replan-depth bound) are reused as-is. What is new is that the
supersession is a first-class, operator-visible Linear object instead of an
internal-only graph mutation.

Because the root is immutable and every regression appends a new node beside the
old one (never nests deeper on retry), the chain grows in breadth under a stable
parent, and `(replan_depth, retry_count)` remains a well-founded, strictly
decreasing budget (base RFC Graph Convergence Contract).

### The retry boundary, precisely

The discriminator is **"does this stay in the same stage or fall back to an earlier
one?"**, not "which stage failed":

| Situation | Same stage? | Action |
|---|---|---|
| execute crashes / times out, gate unchanged | yes | new attempt → comment; bounded |
| verify process itself fails to run | yes | new attempt → comment; bounded |
| verify **judges the approach wrong** → back to plan | no (verify → plan) | cancel old node, new node, inherit edges |
| same-stage bound exhausted | escalation | node → `need_human` |

This **removes the base RFC's `REWORKING` state** (the "same node, same gate, edit
and re-execute in place" middle state). Same-stage failure is either an automatic
retry (comment) or, once bounded out, `need_human`; a genuine change of approach is
always a fresh node. The old `rework_count` is repurposed as the same-stage retry
counter.

## Attempt projection (comments)

Every `AttemptRecord` projects to exactly one comment on its node's issue,
carrying: mode (plan/execute/verify), attempt state, `attempt_id`, `thread_id`,
score (for verify), and a sanitized error summary for failed attempts. A failed
attempt (`state=FAILED`) is clearly marked as such in the comment so "which failed"
is visible at a glance.

**Red line 1 — comments are write-only projection.** Conductor **never reads
scheduling state back from an attempt comment.** `attempt_id`/`thread_id` in a
comment are audit breadcrumbs for humans, not a round-trip data channel. The only
Linear→scheduler ingestion channels are (a) `blocks` edges (base RFC "Ingestion is
union-only and idempotent") and (b) the `need_human` state-flip resume signal
below — nothing else.

**Red line 2 — idempotent by `attempt_id`.** Projection runs on the ~10s reconcile
tick. Each attempt must yield exactly one comment: keyed by `attempt_id` in
Conductor's durable projection-comment mapping, storing Linear's `comment_id`.
Reconcile updates that comment by id when it already exists and creates it only if
absent. The comment body must remain operator-readable and must not contain hidden
HTML marker blocks. Without the durable key the reconcile loop reproduces the
duplicate-message problem this design exists to kill.

## Human handling: `need_human` + state-flip resume

A new node state **`need_human`** replaces the separate `[Human Action]` child
issue for pipeline waits. When a node needs human input (same-stage retries
exhausted, credential required, plan invalid, etc.), the node's own issue enters
`need_human` (projected to a blocked-style Linear workflow state with a structured
reason and `operator_wait_kind`). The human works **in place on that issue**.

**Entering `need_human` always posts an instruction comment.** The state flip is
never silent: the same reconcile pass that moves the issue into the blocked-style
state posts an idempotent comment, replayed by durable `comment_id`, that tells
the operator (a) the structured reason the node stalled, (b) exactly what
information to supply and where (a comment on this issue), and (c) how to resume
— flip this issue's state back out of the blocked state. The comment is the
operator's contract; the state flip is the machine-readable trigger. This comment
is idempotent on the wait's identity (one instruction per wait, not one per tick),
same as attempt comments. Its wording states plainly that adding a comment alone
does not resume — only the state flip does — so the two channels (supplementary
info vs. resume trigger) stay unambiguous.

**Red line 3 — resume trigger is a discrete state flip, not comment parsing.** The
resume signal is the human flipping the issue's workflow state out of the
`need_human` state (a discrete, idempotent, unambiguous event). Comments on the
node are read as *supplementary context* by the node's next attempt, but a comment
**never on its own triggers resume**. This keeps the new resume channel as strict
as `blocks` ingestion and avoids re-deriving intent from free-text prose (base RFC
Root cause A anti-pattern).

This is a deliberate evolution of the base RFC's "human intervention uses a child
issue; completing that child resumes the node" rule. The motivation is the mirror
goal itself: a faithful topology mirror should not spawn a side-channel child issue
for every wait. The safety property the base RFC cared about — *a free-text/parent
comment must never resume work* — is **preserved**, just carried by the state flip
instead of by child-issue completion.

## Linear final shape

```text
Root business issue (immutable, In Progress)
 ├─ [node] implement login       (Done)
 │    · comment: plan#1     → done (thread_id=…)
 │    · comment: execute#1  → FAILED: <sanitized traceback>
 │    · comment: execute#2  → done          ← same-stage retry
 │    · comment: verify#1   → PASSED score 3
 ├─ [node] implement logout v2   (In Progress)  ┄replaces┄┐
 │    · comment: plan#1 → done                             │
 │    · comment: execute#1 → done                          │
 │    · comment: verify#1 → FAILED (approach wrong)        │
 └─ [node] implement logout      (Canceled)   ┄┄┄┄┄┄┄┄┄┄┄┄┘
      · comment: archived, replaced by v2
blocks: login → logout v2   (inherited from the canceled logout node)
```

## Invariants this document changes

Relative to `three-mode-runtime-pipeline.md`:

1. **Removes `REWORKING`.** The GraphNode state set drops `REWORKING`. Same-stage
   failure is a bounded automatic retry (comment) or, once bounded out,
   `need_human`. A change of approach is always a new node (supersede chain), never
   an in-place gate edit. `rework_count` is repurposed as the same-stage retry
   counter.
2. **Adds `need_human`** as an operator-visible node state, resumed by a **state
   flip** on the node's own issue rather than by completing a separate
   `[Human Action]` child issue. The base RFC's "comments/command-like comments
   never resume work" property is preserved via the state-flip trigger.
3. **Attempts are projected** to Linear as idempotent, status-bearing comments
   (keyed by `attempt_id`). Previously attempts had no Linear projection at all.
4. **Replan is surfaced as a visible supersede chain.** The internal replan
   graph-rewrite (SUPERSEDED + atomic revision + edge inheritance) is unchanged;
   it now always materializes as a Canceled-old / new-node-with-`replaces` pair on
   Linear at the same level.

## Invariants this document preserves (unchanged)

- Conductor's durable graph is the single scheduling source of truth; Linear is a
  projection + human-event inbox (base RFC Invariants 1–2, Root cause A authority
  boundary).
- `blocks` = scheduling dependency; dependency satisfied only at upstream
  `VERIFY_PASSED >= 3` (Invariant 6).
- Topology vs. runtime-state split; `graph_revision` versions topology only
  (Invariant 13; Root cause B).
- Union-only, idempotent `blocks` ingestion; a lagging remote read never deletes a
  live local edge; a no-topology-change pass mints no revision (Root cause A/B).
- Every non-terminal node has a live driver; every backward edge decreases a
  well-founded budget; exhaustion escalates to a human, never a loop (Invariant 16;
  Root cause C).
- Gate immutability, verifier isolation, per-mode runtime isolation, capacity as a
  single verified source of truth — all unchanged.

## Open questions for implementation

- **`need_human` → Linear workflow state mapping.** Implemented as a blocked-style
  state name target: `Blocked`, `Needs Human`, or `Need Human`, with Linear state
  type fallback `started`. A resume is any later reconciliation where the node
  issue is no longer in one of those blocked/need-human states.
- **Instruction-comment wording per reason.** Each structured reason
  (`CREDENTIAL_REQUIRED`, `PLAN_INVALID`, same-stage-retry-exhausted, …) needs a
  clear "what to supply / how to resume" template so the operator is never guessing.
  The resume mechanic (state flip) is identical across reasons; only the "what to
  supply" text differs.
- **Comment volume under long chains.** A deep supersede chain plus per-attempt
  comments could get long; decide whether canceled nodes collapse/summarize in the
  projection.
- **Edge inheritance atomicity across the Linear round-trip.** The internal
  atomic-revision rewrite is settled; the projection of "cancel old + create new +
  move all `blocks`" must be idempotent under the ~10s reconcile so a partially
  applied tick doesn't leave dangling or duplicated edges.
```
