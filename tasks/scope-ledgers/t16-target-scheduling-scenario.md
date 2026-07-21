# T16 Target Scheduling Scenario

## authorized

- Add a closed target scheduling evidence boundary for the existing Root
  blocker, priority, and single-writer scheduling policy.
- Prove selected and waiting Root IDs, blocker respect, and the configured
  maximum concurrent Root count.

## required_consequences

- Scheduling evidence is read-only and contains only bounded IDs and policy
  facts; it does not become a queue or checkpoint store.
- An unresolved blocker, invalid Root identity, or concurrency mismatch fails
  closed.

## out_of_scope

- Reimplementing scheduling policy or adding a workflow database.
- Creating cross-Root relations or mutating Linear from the evidence reader.
- Final verdict aggregation and legacy Gate entry removal.

## assumptions_requiring_approval

None.

## deferred_ideas

- Credentialed retained multi-Root scheduling setup and observation.
