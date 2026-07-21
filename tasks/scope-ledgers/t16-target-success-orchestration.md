# T16 Target Success Orchestration

## authorized

- Orchestrate one target success control flow through the closed runner:
  externally create a Root, wait for its matching Plan approval action, append
  a plain Human response to the exact Plan Node, and observe complete durable
  Root facts.
- Reuse the caller-provided runner and observation inputs so production
  Conductor, Performer, Linear, and Git boundaries remain real at acceptance.

## required_consequences

- The created Root identity and Project identity are the only basis for later
  observation and Human response targeting.
- Git observation input is re-read before every durable observation so Work
  commits cannot be evaluated against a stale HEAD.
- Only `needs_approval` may advance this success scenario; `needs_info`,
  duplicate actions, stale actions, malformed facts, and foreign data fail
  closed.
- Bounded incomplete durable-facts errors are surfaced as progress and retried
  only until the scenario deadline; unexpected errors fail immediately.
- The returned value contains only the closed durable facts DTO, never the raw
  snapshot, comments, response body, credentials, process handles, or metadata.

## out_of_scope

- Starting or configuring Conductor, Performer, Podium, Profiles, Linear
  Projects, or Git workspaces.
- Restart recovery, repair/escalation, delivery, multi-Root scheduling, and
  replacing the legacy E2E entry point.
- Marking the target success scenario or T16 acceptance complete without a
  credentialed retained run.

## assumptions_requiring_approval

None.

## deferred_ideas

- Connect this control flow to the production target boundary setup and live
  entry point.
- Collect real restart, repair/escalation, delivery, and scheduling evidence.
