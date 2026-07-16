# Task 4.5a scope ledger

## authorized

- Replace the incomplete private Configure wire shape with the one exact
  secret-free contract approved in the revised Task 4.5a plan.

## required_consequences

- Resolve the Task files to
  `packages/performer-api/src/performer_api/local_runtime.py`,
  `packages/podium/src/podium/local_runtime_commands.py`,
  `tests/test_local_runtime_contract.py`, and
  `tests/test_local_runtime_commands.py`, and
  `tests/test_conductor_podium_ipc.py`.
- Carry canonical repository path, bounded project slug/name, app user id,
  policy revision, and the existing closed `PerformerProfileConfig`.
- Require profile binding/config generation to match context and both backend
  provenance fields to equal `codex`.
- Reject the old lone-profile-id shape and every unknown, secret, provider, or
  second-version field.
- Move every existing direct constructor consumer in the same commit so the
  contract-first slice leaves the repository working without a compatibility
  branch.

## out_of_scope

- Conductor command application, module documentation, CLI bootstrap,
  active tick switching, persistence, schema, UI, or real Linear/Codex runs.
- Compatibility DTOs or a second protocol version.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.5b updates the Podium and Conductor consumers after this contract lands.
