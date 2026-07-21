# T12 Partial Cancellation Recovery Boundary

## authorized

- Exercise the real Conductor entrypoint twice against a serialized workflow
  Tree boundary and a real Git repository/worktree.
- Change an owned Root to Canceled while a Work Stage child is active, then
  recover partial Cycle/Node cancellation in a fresh Conductor process.
- Preserve the existing terminal workflow policy and prevent a new Performer
  Stage from starting during cancellation reconciliation.

## required_consequences

- The first process starts one real Work Stage and is interrupted after the
  external Root cancellation.
- The second process discovers only the same-Conductor owned Canceled Root,
  reuses its deterministic workspace, and persists bounded cancellation
  mutations from the serialized Tree.
- Cycle, Work, and Verify reach Canceled and a durable convergence decision is
  recorded without a second Stage marker.

## out_of_scope

- Credentialed Linear network access and SDK physical requests.
- Stale-result rejection, delivery, repair escalation, or marking T12
  complete.
- Reconsidering the workflow policy for Roots that are already terminal.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add real-process stale-result evidence before final T12 acceptance.
