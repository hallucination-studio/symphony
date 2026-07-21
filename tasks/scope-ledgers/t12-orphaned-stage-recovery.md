# T12 Orphaned Stage Recovery Boundary

## authorized

- Exercise the real Conductor entrypoint twice against a serialized workflow
  Tree boundary and a real Git repository/worktree.
- Start a real Work Stage child, interrupt the first Conductor process, and
  recover the Root from the persisted Tree in a fresh process.

## required_consequences

- The first process creates a Work execution and is interrupted while its
  Stage child is active.
- The second process appends one failed `orphaned_execution` terminal record,
  creates a distinct fresh execution, and accepts only the fresh result.
- Work completion is committed through the real Git workspace, and the final
  worktree has the deterministic branch and no uncommitted changes.
- Workflow mutations are persisted to the serialized Tree and read back from
  disk on every subsequent query.

## out_of_scope

- Credentialed Linear network access and SDK physical requests.
- Human suspension/resolution, Root cancellation, delivery, and T12 final
  completion.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add equivalent real-process boundaries for Human resolution and partial
  cancellation in separate T12 increments.
