# Task 4.3 scope ledger

## authorized

- Send configure and bounded drain commands only through the online private
  session that matches the current active desired binding.
- Keep command generation monotonic and make duplicate ACK handling idempotent
  without allowing stale ACKs to alter the current binding.

## required_consequences

- Resolve `local_runtime_commands.py` to
  `packages/podium/src/podium/local_runtime_commands.py`,
  `conductor_bindings.py` to
  `packages/podium/src/podium/conductor_bindings.py`, `store/bindings.py` to
  `packages/podium/src/podium/store/bindings.py`, and the focused test to
  `tests/test_local_runtime_commands.py`.
- Re-resolve and compare the repository path at the Podium command boundary so
  only the canonical directory committed in the approved binding is sent.
- Mark a binding as draining before sending its drain request, bound ACK waits
  by the request deadline, and expose stable sanitized failure/next-action
  fields.
- Use the Task 4.1 performer-api DTOs and the Task 4.2 process-local session
  registry; do not add another transport or persistence layer.

## out_of_scope

- Conductor-side command handling, switching the active sync path, dispatch
  leasing, runtime reports, process reconciliation, UI, or schema changes.
- Binding edit/revision UI, profile configuration lifecycle, public listeners,
  bearer tokens, or real Linear/Codex execution.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.4 consumes these commands from the inherited Conductor channel.
- Task 4.5 connects the drain admission state to polling, dispatch, and turn
  shutdown ordering.
