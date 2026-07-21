# T15 Stage Runtime Reporting Cleanup

## authorized

- Replace retired turn-scoped Runtime Problem correlation with stage scope.
- Remove the retired turn identifier from the Conductor reporter API, Podium model, parser, and Podium-Conductor schema.
- Remove the unused Conductor Runtime Convergence helper and strengthen the architecture guard against its reintroduction.
- Regenerate the checked-in multi-language contract bindings.

## required_consequences

- Runtime Problem observations accept only the documented application, binding, root, stage, profile, and workspace scopes.
- Runtime Problem wire payloads contain no turn_id field.
- Conductor and Podium tests cover the stage-scoped payload shape.
- No authored Conductor code retains the deleted runtime convergence surface.

## out_of_scope

- Legacy E2E runner replacement deferred to T16.
- Broader legacy Podium root-scope and performer_id vocabulary.
- Historical SDK event-key test data unrelated to Runtime Problem reporting.
- Ignored Python bytecode caches and empty untracked directories.

## assumptions_requiring_approval

None.

## deferred_ideas

- Remove remaining legacy E2E and Podium reporting vocabulary in subsequent roadmap slices.
