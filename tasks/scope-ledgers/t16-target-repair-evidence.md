# T16 Target Repair Evidence

## authorized

- Preserve the target managed `finding`, `finding_disposition`, and
  `convergence` records through the read-only Linear snapshot transport.
- Project one correlated repair/escalation evidence DTO from those durable
  records for the target workflow verdict.

## required_consequences

- Repair evidence is correlated to the observed Root, Cycle, and Verify Node.
- The convergence breaker is derived from the persisted convergence view and
  decision, never from a claimed runner status.
- Unknown record kinds, duplicate identities, malformed records, and foreign
  correlations fail closed.
- The projection exposes only bounded verdict fields; raw managed records and
  arbitrary metadata do not cross the observation boundary.

## out_of_scope

- Creating or mutating Findings, dispositions, convergence records, Cycles, or
  Issues.
- Restart recovery, scheduling, delivery orchestration, process startup, and
  replacement of the legacy E2E entry point.
- Marking the repair/escalation scenario or T16 as accepted at a real external
  boundary.

## assumptions_requiring_approval

None.

## deferred_ideas

- Collect restart and scheduling evidence from their real process boundaries.
- Replace the legacy Gate-oriented E2E after all target scenarios are wired.
