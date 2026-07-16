# Task 4.4 scope ledger

## authorized

- Add the Conductor client for the inherited private Podium channel using only
  performer-api closed local-runtime DTOs.
- Accept a matching drain command, stop admission of new turns, and ACK only
  after workflow.db has no running attempt awaiting result persistence.

## required_consequences

- Resolve the Task files to
  `packages/conductor/src/conductor/podium_ipc.py`,
  `packages/conductor/src/conductor/models.py`,
  `packages/conductor/src/conductor/conductor_service.py`, and
  `tests/test_conductor_podium_ipc.py`.
- Validate inherited handshake and every message against conductor, instance,
  project, binding, and generation identity.
- Keep exact duplicate drain requests idempotent and reject conflicting or
  stale requests without changing admission state.
- Keep the new client constructor free of runtime/proxy tokens, URLs, headers,
  and provider-specific fields.

## out_of_scope

- Switching the active tick, Podium-side dispatch/report persistence, scoped
  Linear gateway execution, process auto-start, UI, or deleting legacy HTTP
  implementation files and settings.
- New workflow.db schema or durable IPC/session state.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.5 wires turn admission and typed command order into the active tick.
- Phase 8 deletes the retained legacy HTTP and token configuration surfaces.
