# T14 Orphaned Turn Surface Cleanup

## authorized

- Remove the unused Conductor `PerformerTurnObservation` module.
- Remove tracked placeholder paths for retired Root Gate, Turn, and Work execution modules.
- Strengthen the architecture guard against reintroducing the deleted Conductor surface.

## required_consequences

- No authored Conductor code imports or exports the deleted observation module.
- Architecture tests reject the retired observation path.
- The cleanup remains independent of workflow behavior and leaves the target Stage composition intact.

## out_of_scope

- Podium runtime-reporting fields and legacy E2E evidence vocabulary.
- Ignored Python bytecode caches and empty untracked directories.
- T15 protocol regeneration and T16 live-boundary runner replacement.

## assumptions_requiring_approval

None.

## deferred_ideas

- Remove remaining legacy E2E and Podium reporting vocabulary in the subsequent roadmap slices.
