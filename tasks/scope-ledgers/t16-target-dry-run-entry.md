# T16 Target Dry-Run Entry

## authorized

- Provide a target-workflow `--dry-run` entry that reads the target source
  topology and reports its static-audit result and unverified scenarios.

## required_consequences

- Dry-run performs no Linear, Git, Conductor, Performer, Profile, or provider
  mutation and never requires credential environment variables.
- Static-audit failure stops the entry before any future orchestration step.
- CLI arguments and failures produce bounded sanitized JSON output.

## out_of_scope

- Credentialed target execution, process startup, polling, scenario mutation,
  cleanup, and durable verdict assembly.
- Wiring this entry into the existing Makefile or replacing the legacy E2E
  entrypoint.
- Marking target scenarios or T16 as passed.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add a target live-mode entry after real Conductor/Performer orchestration and
  retained-boundary fixtures are available.
