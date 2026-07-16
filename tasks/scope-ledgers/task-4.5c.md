# Task 4.5c scope ledger

## authorized

- Bootstrap the installed Conductor from one inherited private IPC file
  descriptor and closed process/session identity metadata.
- Start and stop the existing Conductor service lifecycle without changing the
  active sync tick.

## required_consequences

- Add one validated bootstrap model for the inherited FD, conductor/instance/
  project/binding identity, generation, and one-shot handshake correlation.
- Add a CLI private mode that requires the complete bootstrap argument set,
  rejects public listener arguments, connects the Task 4.4 client before
  starting the service, and closes the channel/service on bounded exit.
- Preserve the existing legacy daemon mode until the ordered 4.5d cutover.
- Emit correlated sanitized startup failure logs and return non-zero for
  invalid/unavailable FD or identity/handshake validation failures.

## out_of_scope

- Receiving Configure/dispatch/drain commands, active tick switching, Podium
  process reconciliation, report transport, listener deletion, tokens,
  provider configuration, UI, or real Linear/Codex runs.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.5d owns the private receive/report tick and removal of the old active
  HTTP sync path.
