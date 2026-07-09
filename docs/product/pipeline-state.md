# Pipeline State

## Authority

Conductor's durable graph store is the scheduling source of truth. Linear is a
projection and human-event inbox. Podium supplies dispatches, scheduler policy,
and runtime profiles, but Conductor owns local graph commits, attempts, leases,
fencing, and convergence.

Every dispatch and attempt is stamped with the graph revision and policy
revision used when it was scheduled.

## Topology And Runtime State

`graph_revision` versions topology only:

- node identity and parentage;
- `blocks` edges;
- frozen gate hash bindings;
- supersession links;
- entry and exit structure.

Topology is immutable once committed. A new revision is minted only by a plan
commit, an atomic replan rewrite, or an ingestion that genuinely changes
topology. A reconciliation pass that observes no topology change must not mint a
revision.

Mutable runtime state is keyed by `node_id` and updated in place:

- lifecycle state;
- current attempt pointers;
- retry count and replan depth;
- verify score;
- escalation reason;
- wait identifiers.

Runtime state is never copied per revision. This keeps in-flight attempts stable
when unrelated topology changes occur.

## Node State

Graph nodes use these durable states:

```text
PLANNED
READY
EXECUTING
VERIFYING
VERIFY_PASSED
REPLANNING
SUPERSEDED
NEED_HUMAN
FAILED
```

`READY` means dependencies are satisfied and capacity may schedule the next
mode. `SUPERSEDED` is terminal for a node replaced by a new graph revision.
`NEED_HUMAN` is terminal until an operator resumes the node.

Same-stage retries do not create replacement nodes. They create new attempts on
the same node, bounded by policy. A regression to an earlier stage creates a
supersede chain.

## Attempt State

Each attempt is immutable once terminal:

```text
PENDING
RUNNING
SUCCEEDED
FAILED
CANCELLED
TIMED_OUT
```

Plan, execute, and verify attempts are stored with mode, attempt id, node id,
lease id, fencing token, request/result paths, backend kind, thread id when the
backend exposes one, sanitized error, timestamps, and artifact references.

## Parentage

`parent_node_id` expresses Linear issue nesting and decomposition ownership only.
It does not participate in scheduler dependency satisfaction, dispatchability,
or derived lifecycle state. Fan-in is represented directly by multiple incoming
`blocks` edges on a node.

## Scheduling

Conductor schedules from the active graph, active scheduler policy, current
runtime profiles, dependency predicate, and live leases.

The dependency predicate is verify-gated: a blocker is satisfied only when the
upstream node verify-passed at score `>= 3` and its verified branch output
manifest is available. Execute completion does not satisfy dependencies.

Capacity is versioned and per-mode:

```yaml
capacity:
  global: 12
  by_mode:
    plan: 2
    execute: null
    verify: 4
```

`null` means no mode-local cap; it is still bounded by global capacity and
dependencies. The API view reports the same active policy object used by the
scheduler, including `policy_id`, `version`, source, limits, active counts, and
remaining counts. Local-default fallback is a surfaced state, not a silent
substitute.

## Leases And Fencing

Capacity accounting is lease-based. A worker may commit a result only if:

- the attempt is still `RUNNING`;
- its lease token is current and unexpired;
- the node has not been superseded;
- execute/verify gate hash still matches the node binding;
- the result path belongs to the fenced attempt.

Expired leases are reclaimed. Stale result files and stale fencing tokens are
warnings with durable reasons, not silent no-ops.

## Convergence

Every non-terminal node must have at least one live driver or explanation:

- an active attempt/lease is running;
- the node can be promoted or dispatched in this scheduler tick;
- an open human/runtime wait explains why it is parked.

A non-terminal node with no live driver is a stuck-node finding. The finding
must create a durable wait/comment with the concrete blockers, capacity error,
profile error, or dispatch-skip reason, and must be visible in state, logs, API
views, and Linear projection when Linear is configured.

Backward movement is bounded by retry count and replan depth. Exhaustion
escalates to `NEED_HUMAN` with a structured reason instead of looping. This
guarantees the graph reaches a terminal state or an explicit operator wait.

## Verification

To verify state behavior, inspect the pipeline API/report and confirm the graph
revision, policy revision, node states, attempt records, leases, queue counts,
and stuck-node findings match correlated Conductor and Performer logs.
