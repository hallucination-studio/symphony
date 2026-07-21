# T16 Target Facts Projection

## authorized

- Project a bounded external Linear/Git Root snapshot into target-workflow
  evidence for Plan, Work, Verify, approval, sealing, progress, and delivery.
- Parse only the target managed-record marker and preserve durable correlation
  fields needed by the target verdict.

## required_consequences

- The projection is read-only and has no Linear SDK, credential, process, or
  mutation dependency.
- Stage evidence is correlated by Root, Cycle, Node, execution, context digest,
  and immutable Git revision.
- Malformed managed records, duplicate records, incomplete DAG facts, and
  mismatched delivery facts fail closed.

## out_of_scope

- GraphQL transport and pagination; the next runner increment supplies the
  bounded external snapshot.
- Creating or updating Roots, Humans, Cycles, Nodes, Findings, commits, or
  delivery.
- Restart, scheduler, and repair orchestration; those remain runner concerns.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add the projection to the credentialed target runner after its transport
  adapter is replaced.
