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
- patch URI and patch hash;
- expected result tree;
- optional result revision;
- artifact URIs and hashes;
- declared commands as context only;
- evidence URI;
- gate snapshot hash.

Declared commands are never trusted as proof. A passing verdict comes from the
verifier running the gate procedure.

## Verifier Workflow

The verifier:

1. creates a fresh disposable workspace;
2. checks out the base revision;
3. fetches the patch and verifies its hash;
4. applies the patch;
5. asserts the resulting tree equals the expected tree;
6. verifies optional result revision provenance if present;
7. verifies artifact hashes;
8. loads the frozen gate by hash;
9. runs the gate procedure;
10. emits a score and sanitized evidence through Conductor.

The first `local-verifier` uses a disposable worktree and mutation detection
after gate execution. It is not OS-level read-only enforcement.

## Task Output Manifests

Conductor publishes a task output manifest only after verify passes. The
manifest is bound to `node_id`, `verify_attempt_id`, `gate_snapshot_hash`, score,
code revision or patch references, artifact references, and integration status.

Executors may suggest output metadata, but Conductor is the publisher. A
downstream node may consume upstream work only through verified manifests.

## Integration

Parallel verified patches are not automatically globally integrated. Each
execute attempt runs against a computed baseline. Entry nodes use the graph base
revision. Dependent nodes use the integrated result of verified blockers or
verified manifests explicitly listed as inputs.

Conductor owns deterministic integration or an integration queue. Conflicts
escalate to `AWAITING_HUMAN` or replanning. The system must not silently merge
conflicting verified patches or let downstream work consume unintegrated output.

## Verification

Acceptance evidence must show the gate hash on execute and verify attempts, the
verification input snapshot, the verifier's actual command/evidence, the score,
the manifest published by Conductor, and any integration or conflict result.
