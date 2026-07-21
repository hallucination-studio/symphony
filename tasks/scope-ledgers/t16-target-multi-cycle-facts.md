# T16 Target Multi-Cycle Facts Projection

## authorized

- Project target durable facts when a Root contains an initial Cycle and
  successor Cycles.
- Select the active Cycle, or the uniquely linked terminal Cycle when no Cycle
  is active, using the persisted Cycle marker relationship.
- Keep Root-level convergence, Finding, and Finding disposition records visible
  across the complete Root history while scoping stage and delivery evidence to
  the selected Cycle.

## required_consequences

- A missing, broken, duplicated, or ambiguous predecessor chain fails closed.
- The existing single-Cycle projection remains behaviorally unchanged.
- No new workflow state, transport, mutation, compatibility path, or local
  persistence is introduced.

## out_of_scope

- Creating or mutating successor Cycles, Findings, dispositions, convergence
  records, Issues, or managed records.
- Repair/escalation orchestration, external Linear acceptance, and provider
  invocation behavior.
- Changes to the legacy `core-live` entry point.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add multi-Cycle selection to retained credentialed target repair runs after
  the repair boundary is implemented.
