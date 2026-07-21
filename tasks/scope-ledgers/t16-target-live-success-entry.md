# T16 Target Live Success Entry

## authorized

- Add a credentialed target success entry that selects a retained Linear
  Project/Team workflow configuration, prepares the Conductor Project Label,
  binds the production Podium/Conductor boundary to an isolated Git fixture,
  and runs the closed single-Root success orchestration.
- Provide a bounded CLI mode that reports missing credentials as unverified and
  never mutates external or local state before configuration is complete.

## required_consequences

- Project and Team/State selection is read back from Linear; the entry creates
  no Cycle, Node, Finding, managed record, commit, or delivery artifact.
- Conductor receives an explicit secret-free child environment and the Codex
  key crosses only the approved Profile control boundary.
- The returned evidence is limited to the success scenario and projected
  durable facts; snapshots, comments, process handles, credentials, and raw
  provider metadata do not cross the entry boundary.
- Local scope cleanup runs after success or failure; a scenario failure remains
  primary if cleanup also fails.

## out_of_scope

- Repair/escalation, restart recovery, delivery, scheduling, final all-scenario
  verdict assembly, CI/Makefile cutover, and removal of `core-live`.
- Automatic cleanup of the retained Linear Root or Project Label before manual
  inspection.

## assumptions_requiring_approval

None.

## deferred_ideas

- Reuse the live setup and evidence lifecycle for the remaining target
  scenarios and replace the retired E2E entry only after all scenarios close.
