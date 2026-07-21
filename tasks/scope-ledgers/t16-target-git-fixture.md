# T16 Target Retained Git Fixture

## authorized

- Create an isolated target E2E run scope and a clean retained Git repository
  that can be bound to the production Conductor harness.
- Read the current target Git branch and immutable HEAD through a bounded,
  read-only observation helper.

## required_consequences

- Run scope paths and cleanup are owned by one validated run ID and cannot
  target an arbitrary directory.
- The fixture starts on `main`, records its initial commit, and does not seed
  workflow files, Linear records, commits, or delivery artifacts.
- Git observation returns only repository path identity, branch, and HEAD;
  Git command output, credentials, and process handles do not cross the helper
  boundary.

## out_of_scope

- Linear Project discovery or mutation, Conductor/Performer startup, target
  success orchestration, restart, repair, delivery, scheduling, and verdict
  assembly.
- Replacing or deleting the legacy `core-live` fixture and entry point.

## assumptions_requiring_approval

None.

## deferred_ideas

- Wire the fixture and observation reader into the credentialed target live
  success entry after the production boundary is complete.
