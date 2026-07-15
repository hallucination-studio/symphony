# Create Conductor auto-start architecture calibration scope ledger

## authorized

- Move Linear project choice into Create Conductor.
- Combine project + repository into one desired-binding creation flow.
- Auto-start immediately after create and on every Podium Desktop start.
- Remove production installation-script/enrollment UX.
- Update architecture, plan, todo, operating guidance, and ADRs before implementation.

## required_consequences

- Remove standalone selected-project target state/API/UI in Task 3.9.
- Add an atomic desired-binding task before IPC/session startup.
- Make active desired bindings the polling and dispatch eligibility fact.
- Keep desired SQLite state separate from observed external process state.
- Use bundled artifacts and native repository picker provenance.

## out_of_scope

- Binding edit/revision/delete UX, automatic repository discovery, remote Conductors, launch at login, service installation, or a second process manager.
- Changes to pool, Managed Run, Gate, runtime waits, provider backend, or Linear OAuth scope.
- Real Linear/Codex E2E execution in the current implementation directive.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Phase 7 real-flow tasks remain pending and are not reported complete.
