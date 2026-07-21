# T16 Target Repair Escalation Orchestration

## authorized

- Orchestrate a target repair/escalation control flow through the closed
  runner: externally create one Root, process each current `needs_approval`
  action exactly once, and observe durable convergence escalation evidence.
- Re-read Git observation before every Root facts observation and return only
  the bounded repair/escalation facts DTO.

## required_consequences

- Only `needs_approval` actions advance the scenario; `needs_info`, duplicate
  action identities, foreign targets, and malformed repair evidence fail
  closed.
- The loop has bounded Human-action and wall-clock limits, and an action that
  remains pending after submission is treated as progress wait rather than
  submitted twice.
- The orchestration owns no workflow persistence, queue, checkpoint, provider
  context, or Linear SDK dependency.

## out_of_scope

- Starting Podium, Conductor, Performer, Profiles, or Git fixtures.
- Creating or mutating Cycles, Findings, dispositions, convergence records, or
  Issues outside the runner's plain Human response boundary.
- Credentialed external acceptance, live entry composition, restart recovery,
  delivery, scheduling, and replacement of `core-live`.

## assumptions_requiring_approval

None.

## deferred_ideas

- Connect this control flow to the retained target production boundary and live
  repair entry after the scenario contract is proven.
