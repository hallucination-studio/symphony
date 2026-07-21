# T16 Target Source Static Audit

## authorized

- Audit the target runner, external-input adapter, and snapshot transport
  source topology before real-boundary orchestration is wired.
- Require Root/Human input wiring and transport-to-projection observation wiring.
- Reject workflow seeding, legacy runner vocabulary, secret environment access,
  and raw snapshot exposure in the target runner boundary.

## required_consequences

- The audit is deterministic, source-based, bounded, and returns only a closed
  pass/failure report.
- The audit does not execute Linear, Git, Conductor, Performer, or provider code.
- A passing audit is not treated as real-boundary evidence or T16 completion.

## out_of_scope

- Replacing the old Gate-oriented runner or entry point.
- Dry-run scenario orchestration, process launch, scheduler observation,
  restart/repair/delivery collection, and final target verdict assembly.
- Any Linear, Git, Profile, or process mutation.

## assumptions_requiring_approval

None.

## deferred_ideas

- Run this audit from the target entry point and add dry-run coverage before
  credentialed retained scenarios.
