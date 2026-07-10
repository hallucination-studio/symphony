# Managed Run State

## Authority

Conductor's durable managed-run store is the execution source of truth. Linear
is the operator projection and human-event surface. Podium supplies dispatches,
runtime configuration, and reporting transport, but Conductor owns local run
state, plan versions, work-item state, checkpoint results, and convergence.

Every delegated Linear parent issue maps to one managed run. The run is resumed
by `run_id`, parent issue id, or issue identifier; duplicate dispatches reuse
the existing run instead of creating a second execution path.

## Durable Objects

The store owns these objects:

- `runs`: parent issue mapping, instance id, run state, active work item,
  backend session id, latest sanitized reason, timestamps, and plan version.
- `plan_versions`: immutable accepted plan payloads.
- `work_items`: current work-item lifecycle, accepted payload, verification
  gate status, and latest structured result.
- `checkpoint_results`: post-group verification command results.
- `linear_projections`: parent/work-item issue mapping and projection metadata.

## Run State

Managed runs use these durable states:

```text
queued
planning
projecting_plan
awaiting_approval
ready
executing
reviewing
verified
blocked
failed
done
```

`ready` means Conductor may select the next dependency-ready work item or
checkpoint. `awaiting_approval` means a planned human approval gate is blocking
execution. `blocked` always carries `latest_reason` with a sanitized,
operator-visible cause. `verified` means all active work items are Done or
canceled by approved revision and all required checkpoints passed. `done` is
allowed only after final Definition-of-Done evidence, residual risks, and the
parent Linear summary are recorded.

## Work-Item State

Work items use the normal Linear lifecycle:

```text
todo
in_progress
in_review
done
blocked
cancelled
```

Conductor selects one dependency-ready `todo` item at a time unless the accepted
plan declares safe backend parallelism. A work item can start only when:

- its dependencies are Done;
- no required checkpoint is pending;
- its file scope is present;
- any `needs_human_approval` gate has been approved;
- runtime capacity allows the turn.

`blocked` work items stay out of Done and expose their `gate_status` in durable
state and Linear projection.

## Plan Versions

The first turn produces a structured plan and must not modify files. Conductor
validates scope, dependency shape, RED/GREEN commands, acceptance criteria,
parallelization policy, and Definition-of-Done rubric coverage before saving
plan version `1`.

Accepted plan versions are immutable. If execution needs a new file scope,
dependency, acceptance criterion, or human decision, the backend requests a plan
revision. Conductor saves the new plan version only after approval, resets the
affected item to Todo, and marks removed work items `cancelled`.

## Verification And Checkpoints

Execution results are claims, not verdicts. Conductor verifies:

- changed files are declared and planned;
- undeclared changes are absent;
- RED evidence was observed;
- required GREEN commands ran;
- acceptance criteria passed;
- secret checks pass;
- checkpoint commands pass after configured work-item groups.

Verification failure blocks the run with a concrete reason. Checkpoint failure
blocks the run even when individual work items passed local checks.

## Recovery

A restarted Conductor resumes from durable state:

- Done and cancelled work items remain terminal;
- checkpoint results remain authoritative;
- the latest backend session id is reused when available;
- the next non-terminal dependency-ready work item is selected;
- blocked reasons remain visible until a real operator action or approved plan
  revision resolves them.

Logs are evidence, not state. Every terminal or human-action-causing failure
must be present in durable state, operator logs, and the relevant Linear
projection.
