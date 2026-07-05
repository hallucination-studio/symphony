# Orchestration State Writer Inventory

This inventory records the phase-state write surface before the single-source
convergence and the target ownership after the change.

## Authoritative Conductor Writes

- `ConductorStore.apply_event(run_id, event)` is the only authority for
  `orchestration_events` and the `orchestration_runs` materialized view.
- `ConductorStore.upsert_orchestration_run(...)` is a compatibility constructor
  for dispatch events. It creates either `dispatch.created` or
  `dispatch.duplicate` through `apply_event`.
- `ConductorStore.update_orchestration_run(...)` is a compatibility wrapper for
  tests and non-phase metadata patches. It writes a `projection.patch` event
  through `apply_event`; it does not directly update `orchestration_runs`.
- `ConductorStore.append_orchestration_event(...)` is a compatibility wrapper
  that delegates to `apply_event`.
- `PhaseReducer` is the role-owned state machine. It computes legal transitions
  and submits events through `apply_event`.
- `ConductorService` may add diagnostic, human-action, or manual-attempt events,
  but these also go through `apply_event`.

## Former Phase Writers Demoted

- `packages/performer/src/performer/orchestrator.py` used to write Linear phase
  labels and states at direct orchestration points such as starting,
  implementation, review, rework, done, failed, blocked, retry, and human action.
  These are projection writes only and must not be read back as phase truth.
- `packages/performer/src/performer/phase_runtime.py` used to set the
  implementation phase label when a phase request started. This is local
  execution scratch and not authoritative.
- `packages/performer/src/performer/phase_executor.py` used to set the failed
  phase label when phase initialization failed. The authoritative fact is now the
  `PhaseAdvanceResult`; Conductor records it as an event.
- Podium dispatch storage owns only dispatch lifecycle: queued, leased, acked.
  Runtime phase is report metadata and must reconcile against Conductor events.

## Read Rule

Phase decisions read `orchestration_runs`, the materialized view derived from
`orchestration_events`. Linear labels, performer JSON, and Podium dispatch rows
are projections or local scratch and cannot decide phase advancement.
