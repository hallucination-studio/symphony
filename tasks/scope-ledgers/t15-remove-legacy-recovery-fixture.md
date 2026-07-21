# T15 Remove Legacy Recovery Fixture

## authorized

- Remove the obsolete integration fixture that imports the retired compiled
  Root dispatch path and models V3/performer conversation recovery facts.
- Preserve current target Root scheduling and recovery unit tests.

## required_consequences

- The integration suite no longer asserts a V3 managed comment or performer
  conversation identity.
- No active test imports the retired `RootDispatchAssessmentPolicy` dist path
  solely to validate the removed recovery model.

## out_of_scope

- Replacement of the old Gate-oriented E2E runner, deferred to T16.
- Changes to current Conductor scheduling, Stage recovery, or Human control
  implementations.
- Ignored Python bytecode caches and empty untracked directories.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add target real-boundary recovery scenarios in T16.
