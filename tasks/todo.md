# Minimal Polling Workflow Rebuild Checklist

Status: proposed for approval as of 2026-07-11. No production implementation is
in progress. `tasks/spec.md` is the target contract; `tasks/plan.md` defines the
cutover.

Statuses: `[ ]` pending, `[~]` in progress, `[x]` complete, `[-]` deferred.

## Approval

- [ ] Approve strict sequential execution; no DAG, parallel scheduling, branches, or joins.
- [ ] Approve the boolean gate: verification commands plus read-only Codex gate turn.
- [ ] Approve one automatic gate rework, then visible blocking.
- [x] Retain plan revisions, approval, risks, architecture decisions,
      open questions, manifests, artifacts, and acceptance-catalog evidence.
- [x] Retain score/rubric/threshold/weight/provenance verifier data
      under one Codex Gate; no cross-model reviewer or second scheduler.
- [x] Delete checkpoint groups; Linear polling checkpoints remain.
- [ ] Approve archiving old local Conductor run state instead of migrating it.
- [ ] Approve removing historical full-log fetch while retaining the current Web cached tail.
- [ ] Confirm Podium customer/OAuth/project/Conductor/binding data must migrate in place.

## Per-Slice Scope Gate

Repeat for every non-trivial task:

- [ ] Record `authorized`, `required_consequences`, `out_of_scope`, `assumptions_requiring_approval`, and `deferred_ideas`.
- [ ] Confirm approval-requiring assumptions are empty before production edits.
- [ ] Write the new behavior test RED before implementing that slice.
- [ ] Verify no Web business, Linear control-plane, secret, or error-visibility regression.
- [ ] Commit one independently revertible slice.

## Phase 0: Hard-Break Baseline

- [ ] `B0.1` Approve `tasks/spec.md` and the five assumptions above.
- [ ] `B0.2` Snapshot current Web routes, business API methods/responses, DOM states, and secret boundaries.
- [ ] `B0.3` Inventory Podium tables/columns containing users, sessions, Linear installations, projects, Conductors, and bindings.
- [ ] `B0.4` Record package/module/LOC/test/tool/doc baselines and build commands.
- [ ] `B0.5` Define the old Conductor database archive location and rollback procedure.

## Phase 1: Delete Old Tests, Tools, And Expanded Docs

- [ ] `D1.1` Delete the current `tests/` tree; recreate only an empty target directory.
- [ ] `D1.2` Delete all current Web test files and `src/test/` helpers.
- [ ] `D1.3` Delete the current `tools/` tree.
- [ ] `D1.4` Delete `docs/decisions/`, `docs/product/`, the old real-run guide, and legacy workflow docs.
- [ ] `D1.5` Consolidate mandatory repository rules into one `AGENTS.md`; keep Web `DESIGN.md`.
- [ ] `D1.6` Remove code-size, architecture inventory, obsolete acceptance
      harness, test/tool/doc command, and stale-plan references; rebuild the
      retained acceptance catalog.
- [ ] `D1.7` Create the new test/tool/doc file skeleton and update `make test`.
- [ ] Milestone `D1`: all production packages import/build; no behavioral-completion claim yet.

## Phase 2: Minimal Shared Contract And Performer

- [ ] `P2.1` Add RED tests for Plan/Task/ExecuteResult/GateResult serialization and validation.
- [ ] `P2.2` Add RED tests for TurnContext exact echo, invalid context, and stale fence.
- [ ] `P2.3` Replace `performer-api` with `workflow.py`, `turns.py`, `runtime.py`, and `validation.py`.
- [ ] `P2.4` Delete capacity, role/profile registries, dependencies,
      parallelization, checkpoint groups, and old exports; retain revision,
      approval, rubric, and provenance contracts.
- [ ] `P2.5` Add RED process tests for `plan`, `execute`, and `gate` request/result files.
- [ ] `P2.6` Rebuild Performer CLI, direct pinned-SDK client, backend prompts, and schemas.
- [ ] `P2.7` Delete compatibility adapter/maybe-await/continuation/default-schema/synthetic-probe/helper fragments.
- [ ] `P2.8` Prove staged real SDK init, plan, execute, read-only gate, resume/wait, timeout, close, and secret isolation.
- [ ] Milestone `P2`: <=5 performer-api modules, <=6 Performer modules, new turn tests green.

## Phase 3: Rebuild Conductor

- [ ] `C3.1` Add RED tests for workflow, plan-revision, catalog, evidence, and
      artifact tables, restart, idempotent run/task creation, and stale fencing.
- [ ] `C3.2` Build minimal `models.py` and one `store.py`; archive old local run state.
- [ ] `C3.3` Add RED test: parent dispatch -> ordered plan -> explicit Linear sub-issues.
- [ ] `C3.4` Add RED test: sequential execute -> commands -> single Codex
      rubric/verifier gate -> evidence projection -> child Done.
- [ ] `C3.5` Add RED test: failed gate -> one rework -> second failure blocks child and parent visibly.
- [ ] `C3.6` Add RED test: all children Done -> parent Done; any non-Done child blocks completion.
- [ ] `C3.7` Build `workflow.py`, `linear.py`, `gate.py`, and `runtime.py` around the minimal state machine.
- [ ] `C3.8` Add runtime-wait `[Human Action]`, exact-task resume, transient retry, and stale-result rejection.
- [ ] `C3.9` Build one service tick and retain the local API plus current Web report shape.
- [ ] `C3.10` Switch the CLI composition root to the new modules.
- [ ] `C3.11` Remove the `Checkpoint` contract, checkpoint coordinator/result
      table, checkpoint workspace, and branch-join helpers; retain revision,
      approval, catalog, rubric, manifest, artifact, and verifier semantics.
- [ ] `C3.12` Delete every duplicated coordinator/driver/projection/store/
      artifact/verifier/human/service/runtime fragment outside the retained
      workflow/evidence owners.
- [ ] `C3.13` Verify failure parity across SQLite, structured logs, Linear, and Podium.
- [ ] Milestone `C3`: module/LOC budget re-estimated for retained revisions,
      catalog, verifier, manifest, and evidence; workflow/recovery tests green.

## Phase 4: HTTP Polling Only

- [ ] `H4.1` Add RED PostgreSQL/API tests for command lease, expiry/reclaim, ack, and stale fence 409.
- [ ] `H4.2` Add `POST /api/v1/runtime/commands/lease|ack` and command status/fencing fields.
- [ ] `H4.3` Change Conductor to one polling loop: report -> command -> dispatch -> workflow.
- [ ] `H4.4` Move smoke result validation/persistence into command ack.
- [ ] `H4.5` Keep cached current log tail; delete historical `log.fetch` command/result path.
- [ ] `H4.6` Delete Podium and Conductor WS routes/tasks/handlers/settings/install fields/presence/dependencies.
- [ ] `H4.7` Delete `dispatch.available`, the in-memory dispatch queue, and duplicate WS wake path.
- [ ] `H4.8` Remove `runtime_groups`; migrate its stable id/FKs to Conductor/binding data without losing customer data.
- [ ] `H4.9` Remove Podium runtime profile/config registry and unnecessary
      `performer_api` dependency; preserve durable policy/plan revision and
      evidence summaries in reports.
- [ ] `H4.10` Merge audited route, SQL statement, smoke protocol, supervisor, mapping, and logging fragments.
- [ ] `H4.11` Re-run OAuth, project pagination/checkpoint/epoch, dispatch, binding, label, proxy, cutover, health, and secret tests.
- [ ] Milestone `H4`: no active `websocket`, `podium_ws`, or `/runtime/ws` reference anywhere.

## Phase 5: Rebuild Web Tests, Preserve Web

- [ ] `W5.1` Read and retain `packages/podium/web/DESIGN.md`.
- [ ] `W5.2` Rebuild `App.test.tsx` for auth and all current routes.
- [ ] `W5.3` Rebuild `api/client.test.ts` for business requests, errors, cookies, and secrets.
- [ ] `W5.4` Rebuild `SetupPage.test.tsx` for the complete onboarding flow.
- [ ] `W5.5` Rebuild `ProductPages.test.tsx` for runtime, account, integrations, home, and managed runs.
- [ ] `W5.6` Adapt only internal policy/profile types needed by the new report; make no visual redesign.
- [ ] `W5.7` Run Web test, lint, build, design lint, desktop/mobile browser DOM/network/console/screenshot checks.
- [ ] `W5.8` Commit rebuilt static assets.
- [ ] Milestone `W5`: <=15 Web tests / <=750 LOC; current business flows unchanged.

## Phase 6: Minimal Product Tests And One Real Flow

- [ ] `F6.1` Finish the seven-file Python suite with about 30 behavior tests / <=2,500 LOC.
- [ ] `F6.2` Build `tools/linear_fixture.py` only for issue creation, delegation, parent tree reads, and cleanup.
- [ ] `F6.3` Build `tools/real_flow.py` for one browser/Linear/polling/dispatch/Codex/sub-issue/gate flow.
- [ ] `F6.4` Make known failures exit immediately and archive `report.json` plus product-owned evidence.
- [ ] `F6.5` Run the real flow from a clean project and staged Codex home.
- [ ] `F6.6` Prove failed gate/error visibility and cleanup in the same runner.
- [ ] `F6.7` Rewrite README, AGENTS, architecture, workflow, and real-flow docs only.
- [ ] `F6.8` Delete all orphan modules, tables, exports, fixtures, compatibility paths, and stale docs.
- [ ] `F6.9` Record final module/LOC/test/tool/runtime metrics.

## Final Gates

- [ ] Every work item is a real Linear child of the delegated parent.
- [ ] Every child reaches Done only after command checks and Codex gate pass.
- [ ] Parent reaches Done only when every planned work child is Done.
- [ ] Restart/replay creates no duplicate run, child, attempt, or dispatch.
- [ ] Stale fencing results change no current state.
- [ ] Failures are sanitized and visible in durable state, logs, Linear, and Podium.
- [ ] Linear OAuth/polling/checkpoint/epoch/dispatch/binding/label/proxy flows pass.
- [ ] Podium Web business flows and secret boundary pass.
- [ ] Runtime transport is HTTP polling only; zero WS residue.
- [ ] New Python/Web suites and the one real flow pass.
- [ ] No cross-model review was run or required; product acceptance remains the
      single Conductor gate.
