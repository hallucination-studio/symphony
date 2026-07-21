# T15 Retire Command Broker Sidecar

## authorized

- Remove the deleted Performer command-broker sidecar from Desktop packaging.
- Remove its stale Tauri external-binary declaration and stop-process pattern.
- Preserve the Performer Stage sidecar and Conductor-owned launch path.

## required_consequences

- Desktop builds only the Podium backend, Conductor, and Stage/Profile Performer
  sidecars.
- Tauri bundles no obsolete `symphony` command-broker binary.
- Repository stop commands do not target the retired turn-request runtime.

## out_of_scope

- Replacement of the old Gate-oriented E2E runner, deferred to T16.
- Changes to retained E2E fixtures or credentialed acceptance scenarios.
- Ignored Python bytecode caches and empty untracked directories.

## assumptions_requiring_approval

None.

## deferred_ideas

- Replace the retained E2E runner with target workflow scenarios in T16.
