# T12 Human Stage Recovery Boundary

## authorized

- Exercise the real Conductor entrypoint twice against a serialized workflow
  Tree boundary and a real Git repository/worktree.
- Suspend a real Work Stage, persist its Human action, then resume after a
  later plain Human comment in a fresh process.

## required_consequences

- The first process persists a suspended Stage terminal and one Human action,
  then releases the Stage without completing Work.
- The second process consumes only the matching plain Human answer and creates
  a fresh Stage execution with a fresh context digest.
- Work completes through the real Git workspace after the answer, with no
  stale answer injected into the first invocation.

## out_of_scope

- Credentialed Linear network access and SDK physical requests.
- Root cancellation, stale-result real-process evidence, delivery, and T12
  final completion.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add the real-process partial-cancellation boundary and stale-result evidence
  in separate T12 increments.
