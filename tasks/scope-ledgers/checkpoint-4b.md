# Checkpoint 4B scope ledger

## authorized

- Verify one real local Podium session/dispatcher and one Conductor
  client/service complete the basic private IPC Configure/report/lease/ACK
  flow.

## required_consequences

- Add one integration test that composes the already committed Podium and
  Conductor implementations over a real inherited socketpair and both SQLite
  stores.
- Record checkpoint evidence and update the task checklist.

## out_of_scope

- Production changes, Desktop process reconciliation, external Linear/Codex
  calls, gateway/report expansion, UI, or HTTP helper deletion.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.6 owns Desktop multi-Conductor process reconciliation.
