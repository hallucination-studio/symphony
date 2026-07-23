# T17 Project Conductor Pool and Parallel E2E Scope Ledger

- `authorized`
  - Allow one Linear Project to carry multiple
    `symphony:conductor/<short-hash>` labels as its Conductor pool.
  - Route each Root to exactly one pool member with a matching Root label.
  - Run the retained real-boundary E2E scenarios in isolated parallel processes,
    each with a hard five-minute process deadline.
  - Before parallel launch, archive every prior Root carrying a valid Symphony
    E2E run marker and prove no prior marked Root remains schedulable; this
    cleanup barrier precedes final pool reconciliation and child creation.
  - Provide an explicitly confirmed operator quiescence path for a marked
    non-terminal E2E Root that is known to have no live runner; preparation
    itself remains fail closed and never invokes this path implicitly.
  - The old sequential/in-process E2E composition is retired; no scenario can
    bypass the preparation barrier or share another scenario's Root/process scope.
- `required_consequences`
  - Separate Project membership, Root routing, and durable Root ownership.
  - Root creation must fresh-validate one selected pool member and write one
    matching Issue Label; it must not seed ownership or workflow evidence.
  - Fail closed on missing, multiple, out-of-pool, stale, or changed Root routing.
  - Preserve the single-label Project behavior for an unlabeled Root.
  - Prevent pool expansion or member removal from stranding non-terminal Roots.
  - Add closed Podium/Conductor contracts, Desktop visibility, architecture
    guards, local tests, and real multi-Conductor evidence.
  - Give business work and cleanup separate bounded budgets under each
    five-minute process watchdog.
  - A watchdog timeout exits `124` immediately after exact process-group
    termination escalation; graceful `close()` and evidence flush are best effort.
  - Make timeout exit independent of graceful `close()`: terminate the exact
    process group, escalate to forced kill, and exit with code 124.
- `out_of_scope`
  - Load balancing, automatic Root assignment, dynamic capacity weighting,
    cross-Project execution, and hot transfer of an active Root.
  - A workflow database, lease table, mirrored queue, or test-only dispatch path.
  - Seeding E2E Cycles, Nodes, Findings, commits, delivery facts, or ownership
    comments.
  - Archiving or changing any unmarked Project Issue.
  - Automatic quiescence, Root takeover, or ownership transfer during setup.
- `assumptions_requiring_approval`
  - none
- `deferred_ideas`
  - Explicit quiesced Root transfer between pool members.
  - Product-level automatic assignment and capacity-aware balancing.
