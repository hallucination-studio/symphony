# T18 Black-box Parallel E2E Scope Ledger

- `authorized`
  - Replace the current workflow-aware target E2E with one black-box run that
    binds the real environment, clears prior E2E-owned data, creates five Roots,
    and starts five production Conductor processes concurrently.
  - Let the E2E runner act as a real Linear user for matching Human Actions by
    submitting explicit approve or reject decisions with the `.env` token.
  - Add a closed, action-correlated Human decision grammar and production
    Conductor handling for approval and rejection.
  - Give the whole command and every child the same absolute 300000ms deadline.
- `required_consequences`
  - Production Conductor exclusively starts Performer and owns Plan/Work/Verify,
    Stage transitions, retries, findings, commits, and delivery.
  - Preparation resolves Team/Project/Profile identity first, cancels and archives
    only valid E2E-marked historical Roots in the configured test Project, proves
    none remain schedulable, then reconciles the five pool members and creates all
    five new routed Roots before any Conductor starts.
  - Approve and reject decisions validate Project, Root, target, action ID,
    context, author, ordering, and replay before Conductor persists a resolution.
  - Rejection supersedes the old Plan Contract and creates a fresh Plan execution
    and fresh action; it never mutates or resumes an old Performer context.
  - Termination grace is reserved inside the deadline; the outer timeout exits
    124 after exact process-group force termination and never waits for graceful
    close, IPC, evidence flush, or external cleanup.
  - The old workflow-specific scenario controllers, fact state machine,
    quiescence gate, and Performer-result probes are removed.
- `out_of_scope`
  - Test-only Performer behavior, fake Stage Results, seeded workflow facts,
    direct E2E mutation of Cycle/Plan/Work/Verify state, or a test dispatch path.
  - Mutation of unmarked Issues, non-test Projects, retained product evidence,
    or arbitrary user comments.
  - Load balancing, active Root transfer, parallel Work within one Root, CI
    deployment, or provider changes.
- `assumptions_requiring_approval`
  - none
- `deferred_ideas`
  - Additional Human decision transports beyond Linear comments.
  - More than five concurrent acceptance Roots after the fixed suite is stable.

This ledger supersedes the E2E orchestration and historical-Root blocking parts
of T17. T17's product Project-pool and Root-routing behavior remains in force.
