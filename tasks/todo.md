# ADR-0002 Implementation Checklist

Statuses use `[ ]` pending, `[~]` in progress, and `[x]` complete. A task is not
complete until focused verification and its separate simplification review are
recorded.

## Phase 0

- [x] `P0.0` Reconcile ADR-0002 with `main`'s polling-only intake contract and restore the known-red docs test (22 focused docs tests; independent simplification review clean).
- [x] `P0.1` Rebase plan, dependency graph, exclusive ownership, and fresh `main` baseline (`759 passed, 1 failed, 1 skipped`; failure recorded under `P0.0`).
- [x] `X0.1` Implement and validate business/scenario/journey catalogs (34 business scenarios, 32 focused scenarios, one canonical journey; 13 focused tests; independent simplification review clean).
- [x] `X0.2` Implement machine-readable change-impact classification, non-downgradable core/major selection, and exact-decision operator promotion of localized changes to full clean-resource G3 (17 focused tests; digest determinism verified; independent re-review clean after closing three required findings).
- [x] `P0.2` Publish invariant-owner and entrypoint-reachability inventories (12 invariant owners; installed entrypoint partition; zero unexplained Performer modules after D1 migration).
- [x] `G0` Verify polling-only docs, plan/import contracts, code-size gate, and a green full baseline (`717 passed, 1 skipped`; 22 docs tests; 25 architecture/import tests; zero size findings).

## Phase 1

- [x] `D1.0` Remove the already-unused Performer `Jinja2` dependency independently (installed metadata and 98 focused tests green; simplification review clean).
- [x] `D1.1` Reconfirm and remove legacy Performer Linear/tracker/tool modules, 38 exclusive nodes, and their `httpx` dependency (1,276 production LOC removed; independent simplification review clean).
- [x] `D1.2` Audit and remove legacy Performer workspace/repository handoff modules and exclusive tests (449 production LOC and two exclusive nodes removed; independent simplification review clean).
- [x] `D1.3` Audit and remove Performer telemetry/one-strategy backend registry and exclusive tests (494 production LOC and four exclusive nodes removed; eight Conductor runtime nodes retained; independent simplification review clean).
- [x] `D2.1` Resolve 39 `PodiumServer` nodes: migrate 38 HTTP tests to direct `create_app`/ASGI and delete one wrapper-only assertion (HTTP behavior retained; independent simplification review clean).
- [x] `D2.2` After `D2.1`, delete six shadow modules, `JsonStoreLegacyMixin` (637 lines total), and 34 additional exclusive nodes while preserving the JSON capability mirror (190 Podium and 69 web tests green; independent simplification review clean).
- [x] `D2.3` In parallel with `D2.1`, add real `PgStore.connect()`/migration contracts, including concurrent lease/reclaim and stale-fence rejection; rename seven false PostgreSQL tests (5 real PostgreSQL contracts and 7 renamed JSON-store nodes green; independent simplification review clean; zero schema/container residue).
- [x] `D2.4` After `D2.3`, rewrite the broken PostgreSQL multiworker probe for `LinearReconciler` and durable state (real PostgreSQL 6 tests green with semantic-failure visibility, restart evidence, and zero residue; size-safe probe/fixture split; independent simplification review clean).
- [x] `D2.5` After `D2.3`, replace remaining JSON-dependent capability tests with narrow fakes or real PostgreSQL contracts (Podium nodes 190 -> 154; migrated test LOC 7,554 -> 6,472; 16 non-PG tests passed with 4 PG skips; 33 real PostgreSQL cutover/replacement/smoke/contracts tests passed with zero schema residue; independent re-review clean after closing three required boundary gaps).
- [x] `D2.6` After `D2.2`-`D2.5`, retire the full Podium JSON mirror only with capability parity and zero remaining JSON consumers (855 production LOC and all eight `json_store*` modules retired; explicit `create_app(store=...)`; 62 real PostgreSQL/cutover/binding/smoke/channel/tombstone tests passed; multiworker probe passed with one lease winner and restart-readable state; clean wheel and installed tombstones clean; zero schema/lock/probe/container residue; independent re-review approved after closing durable-health, exact app-routing, and tombstone-guard findings).
- [x] `D3.1` Move Conductor-only shared contracts out of `performer_api` (managed-run state/gate/summary, ops, and runtime-template sanitizer hard-migrated; 446 ops LOC removed; all three independent simplification reviews clean).
- [x] `D3.2` Move Performer-only Codex contracts out of `performer_api` (12 runtime-read fields retained, 8 dead fields removed, strict secret indirection, 11-module entrypoint closure; independent simplification review clean).
- [x] `D3.3` Delete unused shared labels/ops/tracker contracts and exclusive tests (639 shared LOC removed; 19 wire exports remain; installed metadata has no dependencies; 88 focused contract/import/inventory/docs tests and independent simplification review clean).
- [x] `D3.4` Replace source-string/order tests with behavior or AST boundary checks (13 Python tombstone nodes consolidated into two scoped AST contracts; PostgreSQL behavior replaces SQL source inspection; browser production contracts use TypeScript AST; focused Python/web tests, lint, build, and independent review clean).
- [ ] `G1.1` Close non-E2E structural hard gates: split `runtime_claims_audit.py` below the 350-line limit, remove confirmed dead symbols, and keep import/reachability/architecture checks green.
- [ ] `G1.2` Run fresh non-skipped PostgreSQL concurrency/recovery contracts, Podium web gates, clean wheel/install tombstones, and cleanup checks.
- [ ] `G1.3` Record production/test/tool LOC, nodes, LOC-per-node, domain runtime, invariant-owner coverage, duplicate-owner count, and current direct state-mutation counts.
- [ ] `G1.4` Record an independent simplification review and the temporary scope lock; characterize cataloged behavior that was removed without replacement, especially B16 Linear dependency ingestion.
- [ ] `G1` Pass the deletion/reachability checkpoint. The paused E2E evidence failure stays a named known-red and is neither fixed opportunistically nor counted as green.

## Phase 2: Clean-Architecture Cutover

- [ ] `S0.1` Freeze every currently cataloged business capability as retained through G2; do not perform further functional pruning in Phase 2, and require a product-owner plan amendment to change this order.
- [ ] `S0.2` Require every non-trivial slice to record `authorized|required_consequences|out_of_scope|assumptions_requiring_approval|deferred_ideas`; production edits start only when approval-requiring assumptions are empty.
- [ ] `C0.1` Add Engine facade, typed commands/results, finite effects, repository Protocol, and a Podium-owned `DispatchLeaseRef` distinct from Conductor `TurnLease`.
- [ ] `C0.2` Add aggregate revision, command idempotency, atomic state/effect commit, and overlay/TurnLease/delivery tables.
- [ ] `P1.1` In parallel after the C0 contract, replace Podium `Any`/whole-`PgStore` dependencies with consumer-owned auth, installation, topology, polling, dispatch, runtime-command, and health Protocols.
- [ ] `P1.2` Make each Podium state change plus required command/outbox write atomic and idempotent, beginning with project bind plus `configure`; remove competing direct/once/transactional paths per capability.
- [ ] `T1.1` In parallel after G1, separate local environment bootstrap from fast non-E2E test-domain commands without changing real E2E behavior.
- [ ] `T1.2` Run independent static/docs, contract/unit, Conductor, Podium, Performer, PostgreSQL, and web domains with non-one default concurrency and one structured result envelope.
- [ ] `T1.3` Add an always-run local aggregator that lets independent siblings finish and reports all root causes once; only named failed ancestors may block descendants.
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
- [ ] `C5.1` Cut every coordinator/driver/wait/join/sync/projector state-writing caller over to typed commands or immutable snapshots and remove arbitrary public state mutators.
- [ ] `C5.2` Narrow composition roots and capability ports; remove private cross-package helpers, duplicated parsers, pass-through wrappers, speculative interfaces, and giant implicit `Any` seams exposed by the migration.
- [ ] `C5.3` Publish canonical concept owners and pass three change-radius audits: a role-local optional field, a cross-process wire field, and an additional adapter implementation.
- [ ] `G2` Pass the clean-architecture gate: one decision owner per transition, committed finite effects, atomic replay/recovery, read-only projection, real PostgreSQL lease reclaim, state/API/log parity, zero size findings, and independent simplification approval.

## Phase 3: Product Scope Freeze And Function Pruning

- [ ] `F0.1` Build a complete capability/consumer inventory for authorization, installation/project selection, enrollment/binding, polling/delegation, dispatch/leasing, planning/dependencies, execution/runtime profiles, waits, verification/delivery, projection/operator views, and acceptance evidence.
- [ ] `F0.2` Record actor/job/value, canonical-journey dependency, owner/interface, real callers, durable data/config/API/log/docs/tests, overlap, maintenance cost, and a proposed `keep|merge|remove|defer` decision for every reachable capability.
- [ ] `F0.3` Join the parallel role inventories into one human-approved immutable scope manifest; no deletion starts while any reachable capability is undecided.
- [ ] `F1.1` Land shared wire/schema migrations required by approved merge/remove decisions before role-local consumers change.
- [ ] `F1.2` Retire or merge approved Conductor capabilities in independent one-capability slices with consumer migration, tombstones, focused proof, metrics, and simplification review.
- [ ] `F1.3` In parallel, retire or merge approved Podium capabilities under exclusive files/resources and the same zero-consumer/migration proof.
- [ ] `F1.4` In parallel, retire or merge approved Performer/web capabilities under exclusive files/resources and the same zero-consumer/migration proof.
- [ ] `F2.1` Consolidate duplicate ids, parsers, clocks, state fields, DTOs, read models, error codes, configuration, and dormant flags under their named canonical owners.
- [ ] `F2.2` Map every critical invariant to one cheapest owner test and at most one distinct wiring/real-boundary test; remove overlapping giant tests only after fact parity.
- [ ] `GF` Pass the lean-product gate: no undecided capability, zero retired consumers/references, no compatibility residue, deterministic retained-business and real PostgreSQL contracts green, and before/after code/test/runtime/change-radius metrics recorded.

## Phase 4: Parallel Feedback And Acceptance (Deferred Until GF)

- [ ] `H1.1` Promote the T1 local domains/envelopes/aggregator into the canonical CI and acceptance prerequisite contract.
- [ ] `H1.2` Verify domain ownership, non-one concurrency, no duplicate execution owner, stable timing metrics, and complete root-cause aggregation in CI.
- [ ] `H1.3` Keep real-run bootstrap separate so missing external infrastructure blocks only its named descendants, never independent deterministic jobs.
- [ ] `H2.1` Add check-level dependency DAG, typed snapshots, pure oracles, and validated minimal resource claims.
- [ ] `H2.2` Add work-conserving parallel scenario scheduling, overlap enforcement, and failed/blocked rerun selection.
- [ ] `H2.3` Add append-only evidence, sanitization, hashing, and cleanup ledger.
- [ ] `H3.1` Add complete every-origin Linear issue/comment-version manifest and hard checks.
- [ ] `H3.2` Add eight separate mandatory reviewer dimensions, low-noise hard check, calibration, and partition aggregation.
- [ ] `H3.3` Add canonical/focused scenario definitions with impact triggers and enforce operator-promoted localized decisions as mandatory full G3 runs.

## Phase 5: Live Journey And Cutover (Deferred Until Scope Confirmation)

- [ ] `G3.1` Pass deterministic prerequisites for the canonical customer journey.
- [ ] `G3.2` Pass real browser/OAuth/Linear/Podium/Conductor/Performer/Codex/repository journey.
- [ ] `G3.3` Pass exact delivery and Linear customer-experience evidence gates.
- [ ] `G4` Pass one-time complete business/fact migration parity.
- [ ] `G5.1` Remove `overall-dod`, old runner facades, global collaborator swaps, and duplicate oracles.
- [ ] `G5.2` Update remaining implementation docs only after behavior is real, preserving the polling-only contract.

## Final Gate

- [ ] Every slice has a recorded independent `code-simplification` review.
- [ ] Every final diff traces new behavior and public/durable contracts to its scope ledger; zero `UNAPPROVED_SCOPE_EXPANSION` findings remain.
- [ ] Full Python and Podium web suites pass.
- [ ] Import/reachability and secret scans pass.
- [ ] Required real-run evidence and cleanup pass.
- [ ] Fresh-context multi-axis code review has no unresolved blocker.
- [ ] Worktree is clean and atomic commits explain each migration slice.
