# Task 3.9 scope ledger

## authorized

- Expose the discovered accessible Linear project catalog to the Desktop command bridge.
- Mark whether each project already has an active Conductor binding.
- Remove the early standalone SQLite selected-project state and mutation.

## required_consequences

- Migrate `linear_projects` away from the `selected` column.
- Derive `bound` from active Conductor bindings.
- Preserve bound-project access safety during discovery replacement.

## out_of_scope

- Create Conductor, repository paths, process startup, UI, polling, or dispatch.
- Removing the legacy PostgreSQL/browser selection flow before its ordered deletion phase.
- Real Linear execution.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 3.10 consumes this catalog in the private Create Conductor command.
