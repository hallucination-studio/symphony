# Task 4.2 scope ledger

## authorized

- Register Desktop-created inherited channels with the expected Conductor
  process and binding identity.
- Mark a registered session offline immediately when its expected process exits.

## required_consequences

- Bind each session to conductor, project, binding generation, instance, and
  expected PID before accepting its exact one-shot handshake.
- Reject duplicate bindings/connections, wrong processes, stale generations,
  and reuse of closed or offline sessions.
- Keep session state process-local, secret-free, observable, and close every
  channel during Desktop shutdown.
- Preserve the Task 1.5 `PodiumLocalSession` proof API.

## out_of_scope

- Starting or monitoring Conductor processes, command dispatch, configuration,
  durable runtime reports, dispatch leases, gateway calls, or UI changes.
- Public listeners, bearer tokens, session recovery/reuse, or database schema.
- Real Linear or Codex execution.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.3 sends commands only through matching online registry entries.
- Task 4.6 connects the Desktop process reconciler's exit callback to this API.
