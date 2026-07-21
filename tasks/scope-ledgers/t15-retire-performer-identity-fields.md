# T15 Retire Performer Identity Fields

## authorized

- Remove the obsolete `performer_id` delivery precondition and fact projection.
- Remove `performer_id` and `retry_expected_performer_id` from the Primary
  managed-comment parser and focused fixtures.
- Preserve Conductor-owned Profile identity and Root retry observation.

## required_consequences

- Root delivery validates only current Root, tree, Git, checks, cycle, and
  owner-generation facts.
- Primary managed comments remain closed and readable without a conversation
  identity projection.
- Legacy performer identity cannot be returned by the updated delivery or
  Primary comment paths.

## out_of_scope

- Legacy E2E runner replacement deferred to T16.
- Remaining conversation, root-turn, and command-broker hosts and fixtures.
- Ignored Python bytecode caches and empty untracked directories.

## assumptions_requiring_approval

None.

## deferred_ideas

- Remove the remaining retired Performer host and protocol vocabulary in later
  T15 increments.
