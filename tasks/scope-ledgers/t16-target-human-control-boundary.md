# T16 Target Human Control Boundary

## authorized

- Observe the current target Root's pending Human action from a bounded Linear
  snapshot so a real target scenario can submit a plain Human response to the
  exact waiting Node.
- Expose that observation through the target runner as a closed waiting or
  not-waiting result.

## required_consequences

- The result is correlated to the Root, current Cycle, target Node, request
  kind, action identity, and context digest.
- Root state and the Human action must agree (`Needs Approval` or `Needs Info`);
  duplicate, stale, foreign, or malformed actions fail closed.
- No raw snapshot, comment body, managed record, credential, SDK object, or
  arbitrary metadata crosses the runner boundary.
- This boundary remains read-only; the existing plain Human response mutation
  remains the only external write.

## out_of_scope

- Starting or restarting Conductor/Performer processes.
- Creating or updating Cycles, Nodes, Findings, delivery, scheduler state, or
  managed records.
- Replacing the legacy E2E entry point or marking T16 acceptance complete.

## assumptions_requiring_approval

None.

## deferred_ideas

- Drive the waiting result from the credentialed target success scenario.
- Add real restart, repair/escalation, delivery, and scheduling evidence.
