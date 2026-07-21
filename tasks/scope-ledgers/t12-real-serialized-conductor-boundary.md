# T12 Real Serialized Conductor Boundary Evidence

## authorized

- Exercise the real Conductor entrypoint twice against a serialized workflow
  Tree boundary and a real Git repository/worktree.
- Preserve an already-owned delivered Root in `In Review` during admission so
  workflow reconstruction can observe its terminal cycle state.

## required_consequences

- The external boundary reads the Tree from disk for each workflow-tree query;
  both Conductor processes observe the same sanitized Tree digest.
- The first real Conductor process is killed, and the second receives a fresh
  instance identity and reconstructs the same Root through the private protocol.
- Git creates/reuses the deterministic Root worktree, verifies its branch, and
  reports a clean status after both process lifecycles.
- An owned Root in `In Review` is not silently rewritten to `In Progress`.

## out_of_scope

- Credentialed Linear network access and SDK physical requests.
- Stage execution, orphaned execution terminalization, Human answer recovery,
  cancellation, delivery mutation, and final T12 checklist completion.
- Replacing the legacy E2E runner or marking T12 complete.

## assumptions_requiring_approval

None.

## deferred_ideas

- Replace the closed serialized protocol fixture with the credentialed Linear
  gateway and include an orphaned Stage execution in the process restart.
