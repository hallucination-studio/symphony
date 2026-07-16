# Task 4.5d scope ledger

## authorized

- Switch the active Conductor startup/tick branch to the inherited private IPC
  Configure/report/lease/durable-apply/ACK flow.
- Close admission before drain and prevent WorkflowDriver from starting turns
  while admission is closed.

## required_consequences

- Revise the Task file list to include the Task 4.5c CLI process owner and the
  WorkflowDriver admission boundary; this was committed before production work.
- Add one private sync tick that accepts only closed performer-api messages,
  applies Configure before reporting, persists a matching current lease before
  ACK, and records bounded sanitized failures without forging ACKs.
- Run that tick from private CLI startup and stop the legacy HTTP API server
  from automatically launching its old Podium polling loop.
- Preserve old HTTP helper methods as inactive comparison code for their later
  ordered deletion.

## out_of_scope

- Podium/Desktop process reconciliation, idle/no-lease protocol expansion,
  gateway proxying, report schema expansion, HTTP helper deletion, UI, schema
  migration, provider configuration, or real Linear/Codex runs.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.6 owns process reconciliation and Checkpoint 4C tasks own expanded
  private gateway/report behavior.
