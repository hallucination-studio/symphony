# T12 Serialized Partial Materialization Restart Evidence

## authorized

- Add a Conductor test that rebuilds a partial Bootstrap Plan Tree from
  serialized Linear facts between every accepted mutation.
- Verify exact DAG materialization and sealing after those restart boundaries.

## required_consequences

- The next reconciliation receives a newly constructed execution and gateway
  from `JSON.stringify`/`JSON.parse` state.
- Partial writes remain recoverable through stable write IDs and managed
  records; sealing occurs only after the exact graph and read-back facts exist.
- The test retains the bounded fake Git snapshot and does not add workflow
  state outside Linear facts.

## out_of_scope

- Real Conductor child-process restart around this materialization scenario.
- Real Linear network access, credentialed acceptance, Performer execution,
  Human recovery, cancellation, and T12 checklist completion.

## assumptions_requiring_approval

None.

## deferred_ideas

- Run this serialized Tree fixture through the real Conductor entrypoint and
  real Git worktree once the external protocol fixture can provide a complete
  workflow mutation/read-back boundary.
