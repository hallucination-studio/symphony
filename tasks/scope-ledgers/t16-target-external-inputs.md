# T16 Target External Inputs

## authorized

- Create an externally authored Root in a caller-selected Linear Project.
- Append a plain Human response comment to a caller-selected target Issue.
- Validate mutation responses as closed, project-scoped IDs and status facts.

## required_consequences

- The adapter exposes no Cycle, Node, Finding, relation, commit, delivery, or
  managed-record mutation.
- Root and Human inputs reject unknown fields, unbounded text, managed-record
  framing, and cross-project response identities.
- GraphQL failures are sanitized; credentials and response bodies never enter
  returned values or structured logs.

## out_of_scope

- Conductor or Performer startup, scheduling, stage observation, recovery,
  repair, delivery, and verdict orchestration.
- Project catalog or binding mutation, Git mutation, and credential lifecycle.
- Replacing the legacy E2E runner or marking T16 complete.

## assumptions_requiring_approval

None.

## deferred_ideas

- Wire this external-input boundary into the target runner after its dry-run and
  static audit contract is established.
