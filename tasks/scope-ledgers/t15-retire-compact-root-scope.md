# T15 Retire Compact Root Scope Protocol

## authorized

- Remove the unused Podium-Conductor compact Root Scope query and result.
- Remove its Podium Linear gateway interface, adapter, composition dispatch, tests, and generated contract definitions.
- Preserve the active complete workflow Issue Tree route and its request-capacity coverage.

## required_consequences

- No active schema or authored Podium code defines get_root_scope, root_scope, or RootScope DTOs.
- The removed route no longer exposes the legacy performer identity projection.
- Contract generation and Podium gateway tests cover the remaining active workflow route.

## out_of_scope

- Legacy E2E runner replacement deferred to T16.
- Root delivery and Primary managed-comment performer_id cleanup, which is a separate protocol/authority increment.
- Ignored Python bytecode caches and empty untracked directories.

## assumptions_requiring_approval

None.

## deferred_ideas

- Remove remaining legacy Root delivery and managed-comment performer identity fields in the next T15 increment.
