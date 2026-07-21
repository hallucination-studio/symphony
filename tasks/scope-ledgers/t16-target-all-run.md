# T16 Target All-Run Entry

## authorized

- Add one target-workflow credentialed entry that runs success,
  repair/escalation, restart recovery, delivery, and scheduling as separate
  scenario runs.
- Recompute one verdict from the returned scenario evidence and expose only
  bounded sanitized JSON at the CLI boundary.
- Keep each scenario's local scope cleanup independent and preserve the first
  scenario failure while still attempting later cleanup.

## required_consequences

- Missing configuration is reported as `unverified` before any scenario scope
  or external mutation is created.
- A scenario result is accepted only when its scenario name matches the
  requested scenario and its evidence passes the target verdict projection.
- The all-run result contains no credentials, SDK objects, process handles,
  raw Linear snapshots, or provider metadata.
- The entry does not merge independent Roots into one synthetic workflow.

## out_of_scope

- Changing Conductor workflow policy or adding a workflow database, queue,
  checkpoint, or compatibility path.
- Claiming restart stale-result rejection without evidence from the real
  production boundary.
- Retaining or deleting the legacy runner in this increment; CI, Makefile, and
  documentation cutover follows after the entry contract is proven.

## assumptions_requiring_approval

None.

## deferred_ideas

- A single retained Root lifecycle spanning all five scenarios.
- Automatic cleanup of externally retained Linear Roots after inspection.
