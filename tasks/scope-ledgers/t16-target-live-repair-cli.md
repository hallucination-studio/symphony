# T16 Target Live Repair CLI

## authorized

- Add a bounded `--live-repair` CLI mode that invokes the target repair live
  entry and serializes its sanitized result or stable failure.

## required_consequences

- Missing configuration is reported as `unverified` before any scope or
  external mutation is attempted.
- Existing `--dry-run`, `--live-success`, and invalid-argument behavior remains
  unchanged.
- The CLI exposes no credentials, raw snapshots, process handles, or provider
  metadata.

## out_of_scope

- CI/Makefile cutover, final scenario verdict assembly, automatic cleanup of
  retained Linear data, and replacement of `core-live`.
- Any new workflow mutation or repair policy.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add a single all-scenario target entry after the remaining scenarios are
  wired and credentialed evidence is retained.
