# Task 3.8 scope ledger

## authorized

- Discover every accessible Linear project through the approved gateway operation.
- Persist secret-free project metadata only after full pagination succeeds.
- Reject organization, app-user, or exact-scope drift.

## required_consequences

- Extend the fixed project query/validator with identity and safe project slug fields.
- Preserve the previous complete discovery when a later page fails.
- Record a durable sanitized discovery outcome and correlated operator log.

## out_of_scope

- Project selection or catalog commands.
- Create Conductor, repository binding, polling, dispatch, or UI behavior.
- New Linear scopes, operations, webhook intake, or real Linear execution.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 3.9 removes standalone selection state and exposes the project catalog.
