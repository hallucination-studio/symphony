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
EXECUTE_FAILED
VERIFYING
VERIFY_PASSED
VERIFY_FAILED
REPLANNING
SUPERSEDED
AWAITING_HUMAN
FAILED
```

`READY` means dependencies are satisfied and capacity may schedule the next
mode. `SUPERSEDED` is terminal for a node replaced by a new graph revision.
`AWAITING_HUMAN` is terminal until an operator resumes the node.

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

## Parent Aggregation

Parent nodes are aggregate nodes and are not executed directly. Their display
state is derived from child state:

```text
all exit children VERIFY_PASSED           -> parent VERIFY_PASSED
any child unrecoverably FAILED            -> parent FAILED
any child AWAITING_HUMAN                  -> parent AWAITING_HUMAN
otherwise any child active                -> parent IN_PROGRESS (derived)
```

The coordinator acts on this aggregation. A parent whose children are all
terminal may not remain parked in an active display state.

## Scheduling

Conductor schedules from the active graph, active scheduler policy, current
runtime profiles, dependency predicate, and live leases.

The dependency predicate is verify-gated: a blocker is satisfied only when the
upstream node verify-passed at score `>= 3`. Execute completion does not satisfy
dependencies.

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

Every non-terminal node must have at least one live driver: a dispatchable mode,
an active attempt, or an open human/runtime wait. A node with no live driver is a
stuck-node finding and must be surfaced in state and logs.

Backward movement is bounded by retry count and replan depth. Exhaustion
escalates to `AWAITING_HUMAN` with a structured reason instead of looping. This
guarantees the graph reaches a terminal state or an explicit operator wait.

## Verification

To verify state behavior, inspect the pipeline API/report and confirm the graph
revision, policy revision, node states, attempt records, leases, queue counts,
and stuck-node findings match correlated Conductor and Performer logs.
