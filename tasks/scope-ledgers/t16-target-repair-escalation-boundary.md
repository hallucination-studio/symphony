# T16 Target Repair Escalation Boundary

## authorized

- Bind the target repair/escalation scenario to a caller-supplied production
  boundary and close that boundary after the scenario settles or fails.
- Preserve the scenario's bounded durable-facts result and primary failure
  semantics.

## required_consequences

- The boundary is closed exactly once after a successful start.
- A scenario failure remains primary when cleanup also fails.
- No raw runner, process handle, credential, snapshot, or provider metadata is
  returned.

## out_of_scope

- Live Project configuration, Git fixture creation, Conductor Project Label
  setup, CLI entrypoint changes, and credentialed external acceptance.
- Repair/escalation workflow mutation outside the scenario's plain Human
  response boundary.
- Restart recovery, delivery, scheduling, and legacy `core-live` behavior.

## assumptions_requiring_approval

None.

## deferred_ideas

- Compose this boundary into the retained target repair live entry.
