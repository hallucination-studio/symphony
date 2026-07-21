# T16 Target Facts Transport

## authorized

- Read a bounded target Root tree from Linear GraphQL and normalize it for the
  target durable-facts projection.
- Follow bounded Issue, comment, and inverse-relation pages and normalize
  `blocked_by`/`blocks` topology into exact `blocks` evidence.
- Carry caller-supplied immutable Git head and branch through the closed
  snapshot boundary.

## required_consequences

- The transport is read-only and never creates, updates, archives, or deletes
  Linear Issues, comments, relations, Projects, labels, or Git objects.
- Linear response shape, Project/Root/Issue scope, cursor progress, duplicate
  identities, and page bounds fail closed.
- Authorization material is used only in the request header and never appears
  in returned snapshots or structured logs.
- Node markers are used only to normalize target node kind/key; they are not
  exposed as arbitrary record data to the projection.

## out_of_scope

- Creating external Root or Human inputs.
- Conductor, Podium, Performer, scheduler, repair, restart, or delivery
  orchestration.
- Git mutation, Git worktree discovery, GraphQL mutation, and credential
  lifecycle management.

## assumptions_requiring_approval

None.

## deferred_ideas

- Connect this read-only transport to the replacement target runner and its
  retained real-boundary scenarios.
