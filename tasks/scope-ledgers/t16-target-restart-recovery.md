# T16 Target Restart Recovery

## authorized

- Add a target-workflow restart-recovery scenario over the production
  Podium/Conductor boundary and the closed Linear snapshot runner.
- Restart the real Conductor process after a durable Human action exists, then
  resume the same Root from freshly projected Linear and Git facts.
- Expose only sanitized lifecycle evidence needed by the target verdict.

## required_consequences

- The restart path owns process termination, re-launch, and cleanup; callers
  never receive process handles, IPC channels, SDK objects, or credentials.
- The resumed scenario re-reads and correlates the same Root, Cycle, Node,
  action, and context digest before submitting Human input.
- Restart failures and cleanup failures remain visible as stable errors; no
  indefinite retry or silent fallback is introduced.
- The child environment remains secret-free across every Conductor instance.

## out_of_scope

- Delivery, scheduling, final verdict aggregation, and removal of the legacy
  Gate-oriented entry point.
- Simulating provider output or claiming credentialed acceptance without real
  Linear, Git, Conductor, and Performer evidence.
- New durable workflow state or a restart checkpoint outside Linear and Git.

## assumptions_requiring_approval

None.

## deferred_ideas

- In-flight Stage interruption with a retained provider fixture that makes
  stale-result rejection deterministic.
- A single all-scenario credentialed evidence collector and CLI verdict.
