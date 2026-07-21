# T12 Serialized Stage Recovery Evidence

## authorized

- Strengthen the target Work recovery test at the real Performer and Git
  boundaries.
- Rebuild the restart-side Linear workflow fixture from serialized durable Tree
  facts before orphan reconciliation and fresh execution creation.

## required_consequences

- Recovery does not reuse an in-memory workflow object as its source of truth.
- The exited Performer leaves an orphaned execution that Conductor terminalizes
  conservatively and replaces with a fresh execution identity.
- The real Git worktree remains clean across recovery and the retry reaches a
  validated Stage-ready state.

## out_of_scope

- Real Linear network access, full Conductor process restart, Plan/Verify
  recovery, cancellation, and Human answer orchestration.
- T12 checklist completion or changes to production recovery behavior.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add serialized restart evidence for suspended Human and partial cancellation
  paths before marking T12 complete.
