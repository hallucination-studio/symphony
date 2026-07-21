# T16 Target Runner Boundary

## authorized

- Expose external Root creation and plain Human response submission through the
  already-closed input adapter.
- Read a bounded Linear/Git snapshot through the target transport and project it
  into durable target workflow facts.

## required_consequences

- The runner boundary exposes only `createRoot`, `appendHumanResponse`, and
  `observeRoot`.
- Raw Linear comments, credentials, process handles, Git handles, and arbitrary
  snapshot metadata do not cross the observation result.
- Missing dependencies and invalid projection results fail with stable reasons.

## out_of_scope

- Conductor or Performer startup, scheduling, repair, restart, delivery, or
  verdict orchestration.
- Cycle, Node, Finding, relation, commit, delivery, project, or binding
  mutations.
- Static audit, dry-run entry point, replacement of the legacy runner, and T16
  acceptance completion.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add the target source audit and dry-run contract before wiring real process
  orchestration.
