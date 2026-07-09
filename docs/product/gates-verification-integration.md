# Gates, Verification, And Integration

## Gate Authority

Gates are immutable snapshots bound to graph nodes by hash. Linear may render a
gate for humans, but Conductor's `GateSpecSnapshot` is authoritative.

A node cannot execute until it has a frozen gate hash. Execute attempts may read
the snapshot but cannot mutate it. Verify attempts must use the same hash.
Changing a gate requires a new gate version or a replacement node through
replanning.

## Gate Snapshot

A gate snapshot contains:

- snapshot id, task/node id, version, creator attempt id, and timestamp;
- acceptance criteria;
- executable verification procedure;
- provenance tag on every verification step;
- rubric scores `0` through `4`;
- global `pass_threshold = 3`;
- canonical content hash;
- `frozen = true`.

The pass threshold is global. Task-local rubrics may refine wording but may not
lower the threshold.

## Step Provenance

Every verification step has one source:

```text
issue_requirement
appendix_harness
planner_inferred
system_repair
```

`issue_requirement`, `appendix_harness`, and `system_repair` steps are
authoritative. Failing them fails the node.

`planner_inferred` steps are advisory-conservative. They may lower confidence
within an otherwise satisfied gate, but they cannot be the sole reason a node
falls below the pass threshold. A gate with no authoritative step is invalid.

## Rubric

Scores have stable semantics:

```text
0 = no valid implementation, or unverifiable
1 = attempted, but the core gate fails
2 = partial, mock-only, insufficient evidence, or not release-worthy
3 = gate passes with real-run evidence; non-blocking concerns only
4 = gate passes with robust evidence and edge-case coverage
```

Only score `>= 3` verify-passes a node and satisfies dependencies.

## Plan Repair And Validation

Planner output is a proposal. Conductor applies deterministic repair and then
deterministic validation before committing a graph revision.

Repair may add missing dependency edges, normalize gate structure, and demote
unsupported exact-text assertions to advisory provenance. Repairs are stamped as
`system_repair` where they carry authority.

Validation rejects proposals with missing gates, non-executable procedures,
invalid rubrics, threshold changes, cycles, illegal `blocks`, missing entry/exit
nodes, too many subtasks, executor-only verifier requirements, inaccessible
credentials, no authoritative gate step, invalid provenance, or required
parallel dependency shape violations.

## Verification Input

Every terminal execute attempt produces an immutable verification input snapshot:

- task/node id and execute attempt id;
- base revision;
- branch name;
- commit sha;
- no-change flag when applicable;
- artifact URIs and hashes;
- declared commands as context only;
- evidence URI;
- gate snapshot hash.

Legacy patch snapshots (`patch_uri`, `patch_hash`, `expected_result_tree`, and
`result_revision`) may be accepted for migration compatibility, but the current
execute contract is branch/commit handoff.

Declared commands are never trusted as proof. A passing verdict comes from the
verifier running the gate procedure.

## Verifier Workflow

The verifier:

1. creates a fresh disposable workspace;
2. materializes the execute commit in a detached worktree;
3. verifies artifact hashes;
4. loads the frozen gate by hash;
5. runs the gate procedure;
6. emits a score and sanitized evidence through Conductor.

The first `local-verifier` uses a disposable worktree and mutation detection
after gate execution. It is not OS-level read-only enforcement.

## Task Output Manifests

Conductor publishes a task output manifest only after verify passes. The
manifest is bound to `node_id`, `verify_attempt_id`, `gate_snapshot_hash`, score,
branch name, commit sha, and artifact references.

Executors may suggest output metadata, but Conductor is the publisher. A
downstream node may consume upstream work only through verified manifests.

## Branch Join

Parallel verified branches are not automatically globally integrated. Each
execute attempt runs against a computed baseline. Entry nodes use the graph base
revision. Dependent nodes use a Conductor-created worktree branch where every
verified blocker branch has been merged.

Conductor owns the deterministic git join before dispatching the dependent
executor. Conflicts create a merge-conflict resolver node; unresolved conflicts
escalate to `need_human`. The system must not silently merge conflicting
verified branches or let downstream work consume unjoined output.

## Verification

Acceptance evidence must show the gate hash on execute and verify attempts, the
verification input snapshot, the verifier's actual command/evidence, the score,
the manifest published by Conductor, and any join, resolver, delivery, or
conflict result.
