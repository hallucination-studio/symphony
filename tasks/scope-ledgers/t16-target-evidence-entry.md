# T16 Target Evidence Entry

## authorized

- Assemble the five target scenario results into the existing closed durable
  evidence verdict and expose target scenario CLI modes.
- Recompute the verdict from projected facts, not claimed scenario status.

## required_consequences

- Each scenario preserves its own correlated Root/Cycle/Stage facts; the
  aggregator never merges independent Roots into one synthetic workflow.
- Evidence assembly contains no credentials, SDK objects, process handles, raw
  snapshots, or provider metadata.
- Missing configuration is reported as unverified before setup or mutation.
- Unknown scenario results and malformed result shapes fail closed.

## out_of_scope

- Retaining or deleting old Gate tests and implementation in this increment.
- Inventing a second workflow authority or combining independent Roots as one
  successful run.
- Claiming credentialed acceptance without real Linear/Git/Conductor/Performer
  execution.

## assumptions_requiring_approval

None.

## deferred_ideas

- One retained Root lifecycle that exercises all five scenarios in one
  credentialed run.
- CI and Makefile migration after the target entry is fully wired.
