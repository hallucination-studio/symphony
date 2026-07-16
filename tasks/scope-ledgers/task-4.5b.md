# Task 4.5b scope ledger

## authorized

- Apply the complete private Configure DTO through the existing Conductor
  structured profile validation and workflow.db instance persistence.
- Document the complete local runtime Configure contract.

## required_consequences

- Resolve the Task files to
  `packages/conductor/src/conductor/conductor_podium_sync.py`,
  `packages/conductor/src/conductor/conductor_service.py`,
  `tests/test_conductor_private_configure.py`, and
  `docs/modules/performer-api.md`.
- Map only exact DTO fields into the existing structured project/profile apply
  path and persist policy revision with binding/profile generation.
- Make exact duplicates idempotent and reject stale generation, hash drift,
  repository drift, and project mismatch without mutating current durable state.
- Record rejected private configuration in a correlated sanitized log/failure
  state that a later private report can consume.

## out_of_scope

- CLI bootstrap, active tick switching, report transport, dispatch leasing,
  schema changes, UI, legacy HTTP deletion, or real Linear/Codex runs.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.5d includes the bounded failure state in the active private report.
