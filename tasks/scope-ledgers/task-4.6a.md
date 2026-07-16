# Task 4.6a scope ledger

## authorized

- Complete the approved inherited-handle design by handing dynamically created
  per-Conductor channel endpoints from Desktop to an already-running Podium
  sidecar.
- Preserve Desktop process ownership and Podium session/identity validation.

## required_consequences

- Start Podium with one inherited handle-handoff broker owned by Desktop and
  Podium; the broker carries only exact session metadata and OS handles, never
  runtime domain payloads.
- Add a bounded Unix handle-transfer implementation for macOS/Linux and an
  explicit non-Unix No-Go until the approved duplicated-handle equivalent is
  implemented and tested in this task.
- Let Podium adopt a transferred socket into its existing local session
  registry, validate exact identity/generation/PID/session correlation, and
  close rejected/replayed handles.
- Prove a long-lived Podium process can accept two sequential isolated sessions
  without restart or named/public listener.

## out_of_scope

- Multi-Conductor desired binding reconciliation, spawning Conductors, runtime
  payload relay, named endpoints, tokens, process-owner fallback, UI, gateway,
  or report expansion.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.6b consumes the completed handoff when spawning/reconciling Conductors.
