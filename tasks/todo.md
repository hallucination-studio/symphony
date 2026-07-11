# ADR-0002 Implementation Checklist

Statuses use `[ ]` pending, `[~]` in progress, and `[x]` complete. A task is not
complete until focused verification and its separate simplification review are
recorded.

## Phase 0

- [ ] `P0.0` Reconcile ADR-0002 with `main`'s polling-only intake contract and restore the known-red docs test.
- [x] `P0.1` Rebase plan, dependency graph, exclusive ownership, and fresh `main` baseline (`759 passed, 1 failed, 1 skipped`; failure recorded under `P0.0`).
- [ ] `X0.1` Implement and validate business/scenario/journey catalogs.
- [ ] `X0.2` Implement machine-readable change-impact classification, non-downgradable core/major selection, and exact-decision operator promotion of localized changes to full clean-resource G3.
- [ ] `P0.2` Publish invariant-owner and entrypoint-reachability inventories.
- [ ] `G0` Verify polling-only docs, plan/catalog/import contracts, code-size gate, and a green full baseline.

## Phase 1

- [ ] `D1.0` Remove the already-unused Performer `Jinja2` dependency independently.
- [ ] `D1.1` Reconfirm and remove legacy Performer Linear/tracker/tool modules, 38 exclusive nodes, and their `httpx` dependency.
- [ ] `D1.2` Audit and remove legacy Performer workspace/repository handoff modules and exclusive tests.
- [ ] `D1.3` Audit and remove Performer telemetry/one-strategy backend registry and exclusive tests.
- [ ] `D2.1` Resolve 39 `PodiumServer` nodes: migrate 38 HTTP tests to direct `create_app`/ASGI and delete one wrapper-only assertion.
- [ ] `D2.2` After `D2.1`, delete six shadow modules, `JsonStoreLegacyMixin` (637 lines total), and 34 additional exclusive nodes while preserving the JSON capability mirror.
- [ ] `D2.3` In parallel with `D2.1`, add real `PgStore.connect()`/migration contracts, including concurrent lease/reclaim and stale-fence rejection; rename seven false PostgreSQL tests.
- [ ] `D2.4` After `D2.3`, rewrite the broken PostgreSQL multiworker probe for `LinearReconciler` and durable state.
- [ ] `D2.5` After `D2.3`, replace remaining JSON-dependent capability tests with narrow fakes or real PostgreSQL contracts.
- [ ] `D2.6` After `D2.2`-`D2.5`, retire the full Podium JSON mirror only with capability parity and zero remaining JSON consumers.
- [ ] `D3.1` Move Conductor-only shared contracts out of `performer_api`.
- [ ] `D3.2` Move Performer-only Codex contracts out of `performer_api`.
- [ ] `D3.3` Delete unused shared labels/ops/tracker contracts and exclusive tests.
- [ ] `D3.4` Replace source-string/order tests with behavior or AST boundary checks.
- [ ] `G1` Full suite, reachability, LOC/test-owner report, and simplification review.

## Phase 2

- [ ] `C0.1` Add Engine facade, typed commands/results, finite effects, repository Protocol, and a Podium-owned `DispatchLeaseRef` distinct from Conductor `TurnLease`.
- [ ] `C0.2` Add aggregate revision, command idempotency, atomic state/effect commit, and overlay/TurnLease/delivery tables.
- [ ] `C0.3` Make `dispatch.available` notification-only and atomically enforce one run per bound-project/Linear-issue while preserving every replayed state.
- [ ] `C1.1` Commit plan, work items, frozen gates, approval disposition, and run state through one planning decision while preserving append-only versions.
- [ ] `C1.2` Add immutable `DependencyOverlay` and effective readiness without rewriting accepted work items.
- [ ] `C2.1` Migrate plan/work-item attempts to durable Conductor `TurnLease` reservations before launch.
- [ ] `C2.2` Launch only from committed effects; blocked work-item approval emits no process start.
- [ ] `C2.3` Enforce real global/per-role capacity from all active, non-expired TurnLeases across all runs.
- [ ] `C2.4` Quarantine stale results without failing current work.
- [ ] `C3.1` Move Linear observations to typed operator commands and remove projector ingestion, deferring terminal completion cutover to `C4.3`.
- [ ] `C3.2` Migrate managed and runtime waits through engine commands.
- [ ] `C4.1` Deterministically assemble and verify the final candidate from the frozen base revision without changing the customer's checked-out branch.
- [ ] `C4.2` Persist `DeliveryAttempt` before Git ref materialization.
- [ ] `C4.3` Reconcile Git ref to `DeliveryRecord -> done` after crashes.
- [ ] `G2` Deterministic system, PostgreSQL lease reclaim, state/API/log parity, and simplification review.

## Phase 3

- [ ] `H1.1` Separate environment bootstrap from local test commands.
- [ ] `H1.2` Add parallel test domains with non-one default concurrency and common structured result envelopes.
- [ ] `H1.3` Add always-run collect-all root-cause aggregation; block only named failed descendants and never cancel siblings.
- [ ] `H2.1` Add check-level dependency DAG, typed snapshots, pure oracles, and validated minimal resource claims.
- [ ] `H2.2` Add work-conserving parallel scenario scheduling, overlap enforcement, and failed/blocked rerun selection.
- [ ] `H2.3` Add append-only evidence, sanitization, hashing, and cleanup ledger.
- [ ] `H3.1` Add complete every-origin Linear issue/comment-version manifest and hard checks.
- [ ] `H3.2` Add eight separate mandatory reviewer dimensions, low-noise hard check, calibration, and partition aggregation.
- [ ] `H3.3` Add canonical/focused scenario definitions with impact triggers and enforce operator-promoted localized decisions as mandatory full G3 runs.

## Phase 4

- [ ] `G3.1` Pass deterministic prerequisites for the canonical customer journey.
- [ ] `G3.2` Pass real browser/OAuth/Linear/Podium/Conductor/Performer/Codex/repository journey.
- [ ] `G3.3` Pass exact delivery and Linear customer-experience evidence gates.
- [ ] `G4` Pass one-time complete business/fact migration parity.
- [ ] `G5.1` Remove `overall-dod`, old runner facades, global collaborator swaps, and duplicate oracles.
- [ ] `G5.2` Update remaining implementation docs only after behavior is real, preserving the polling-only contract.

## Final Gate

- [ ] Every slice has a recorded independent `code-simplification` review.
- [ ] Full Python and Podium web suites pass.
- [ ] Import/reachability and secret scans pass.
- [ ] Required real-run evidence and cleanup pass.
- [ ] Fresh-context multi-axis code review has no unresolved blocker.
- [ ] Worktree is clean and atomic commits explain each migration slice.
