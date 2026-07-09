# Gates, Verification, And Integration

## Gate Authority

Gates are immutable verification contracts bound to accepted work items. Linear
may render a gate for humans, but Conductor's accepted plan and result checks are
authoritative.

A work item cannot execute until it has file scope, RED/GREEN commands,
acceptance criteria, and dependency state from the accepted plan. Execute turns
may read that contract but cannot mutate it. Changing the contract requires an
approved plan revision.

## Gate Snapshot

A gate snapshot contains:

- run id, work item id, plan version, creator attempt id, and timestamp;
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
acceptance_appendix
planner_inferred
system_repair
```

`issue_requirement`, `acceptance_appendix`, and `system_repair` steps are
authoritative. Failing them fails the work item.

`planner_inferred` steps are advisory-conservative. They may lower confidence
within an otherwise satisfied gate, but they cannot be the sole reason a work
item falls below the pass threshold. A gate with no authoritative step is invalid.

## Rubric

Scores have stable semantics:

```text
0 = no valid implementation, or unverifiable
1 = attempted, but the core gate fails
2 = partial, mock-only, insufficient evidence, or not release-worthy
3 = gate passes with real-run evidence; non-blocking concerns only
4 = gate passes with robust evidence and edge-case coverage
```

Only score `>= 3` verifies a work item and satisfies dependencies.

## Plan Repair And Validation

Planner output is a proposal. Conductor applies deterministic validation before
committing a managed-run plan version.

System repairs may normalize gate structure and demote unsupported exact-text
assertions to advisory provenance. Repairs are stamped as `system_repair` where
they carry authority.

Validation rejects proposals with missing gates, non-executable procedures,
invalid rubrics, threshold changes, dependency cycles, too many work items,
executor-only verifier requirements, inaccessible
credentials, no authoritative gate step, invalid provenance, or required
parallel dependency shape violations.

## Verification Input

Every terminal execute attempt produces an immutable verification input snapshot:

- work item id and execute attempt id;
- base revision;
- branch name;
- commit sha;
- no-change flag when applicable;
- artifact URIs and hashes;
- declared commands as context only;
- evidence URI;
- gate snapshot hash or accepted plan version.

Patch snapshots are diagnostic artifacts only. The accepted execution handoff is
the branch/commit plus the structured `WorkItemResult`.

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
manifest is bound to `work_item_id`, `verify_attempt_id`, accepted plan version,
score, branch name, commit sha, and artifact references.

Executors may suggest output metadata, but Conductor is the publisher. A
downstream work item may consume upstream work only through verified manifests.

## Branch Join

Parallel verified branches are not automatically globally integrated. Each
execute attempt runs against a computed baseline. Entry work items use the
managed-run base revision. Dependent work items use a Conductor-created worktree branch where every
verified blocker branch has been merged.

Conductor owns the deterministic git join before dispatching the dependent
executor. Conflicts block the affected work item or require an approved resolver work item; unresolved conflicts
escalate to `need_human`. The system must not silently merge conflicting
verified branches or let downstream work consume unjoined output.

## Verification

Acceptance evidence must show the gate hash on execute and verify attempts, the
verification input snapshot, the verifier's actual command/evidence, the score,
the manifest published by Conductor, and any join, resolver, delivery, or
conflict result.
