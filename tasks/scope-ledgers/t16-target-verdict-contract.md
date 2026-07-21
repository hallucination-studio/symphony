# T16 Target Verdict Contract

## authorized

- Define the pure acceptance boundary for target-workflow E2E evidence.
- Require success, repair/escalation, restart recovery, delivery, and
  scheduling scenarios to be represented by closed correlated facts.
- Reject stale or mismatched Stage results, false progress, convergence
  breaker bypass, wrong delivery revisions, and leaked secrets.

## required_consequences

- The verdict has no dependency on Linear SDK objects, Git process handles,
  Performer credentials, or arbitrary provider metadata.
- Every accepted Plan, Work, and Verify record is correlated to the same Root,
  Cycle, and context digest; delivery matches the immutable Verify revision.
- A verdict is recomputed from supplied evidence and never trusts a claimed
  runner status.

## out_of_scope

- Launching Conductor or Performer processes.
- Creating Linear Roots, Human actions, Cycles, Nodes, Findings, commits, or
  delivery records.
- Replacing the existing Gate-oriented runner, monitor, fixtures, or entry
  point; those are subsequent T16 increments.

## assumptions_requiring_approval

None.

## deferred_ideas

- Real-boundary evidence collection and scenario orchestration.
- Removal of the retired runner and its Gate-oriented fixtures.
