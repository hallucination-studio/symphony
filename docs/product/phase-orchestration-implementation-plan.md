# Phase Orchestration Implementation Plan

This plan drives the codebase from the current state — where the Conductor phase
state machine exists but Performer still runs the whole legacy flow per call —
to the target in
[Runtime Orchestration Architecture](./runtime-orchestration-architecture.md).

Each stage is independently shippable, independently testable, and ordered by
dependency. Acceptance criteria use the AGENT.md 0–4 rubric. A stage is "done"
only when every criterion is met with fresh evidence.

## Current baseline (already landed)

- `performer_api/phase.py`: `PhaseAdvanceRequest` / `PhaseAdvanceResult` /
  `RunPhase`, no `thread_id` leakage.
- `conductor_phase.py`: `PhaseReducer` (pure transitions), `OrchestrationRun`,
  `OrchestrationEvent`, crash backoff with `crash_limit`, `awaiting_human`.
- `conductor_store.py`: orchestration run/event persistence.
- `conductor_runtime.py` + `cli.py`: Conductor invokes Performer via
  `--advance-request-path` / `--phase-result-path`.
- Tests green: `test_phase_contract`, `test_conductor_phase`, `test_cli`,
  `test_conductor_service`, `test_conductor_runtime`, `test_import_boundaries`.

## Known scaffolding to remove

- `cli.py::run_phase_advance` calls the whole legacy `dispatch_issue_by_id`
  regardless of `current_phase`.
- `cli.py::_phase_result_from_state` reverse-engineers the legacy orchestrator's
  private `state` (`completed`/`human_interventions`/`retry_attempts`/`blocked`)
  to synthesize a `PhaseResult`. This is a bridge, not the target.
- `PhaseAdvanceRequest.current_phase` is transmitted but never consumed.

---

## Stage 1 — Performer executes by phase (remove the scaffolding)

**Goal:** Performer consumes `current_phase` and executes only that phase,
returning a `PhaseAdvanceResult` built from the phase outcome directly — not from
reverse-reading legacy state.

### Work

1. Add `Orchestrator.advance(request: PhaseAdvanceRequest) -> PhaseAdvanceResult`
   in `performer` that dispatches on `request.current_phase`:
   - `QUEUED` / `REWORKING` → implementation only.
   - `REVIEWING` → acceptance gate evaluation only.
   - resume with `human_response` when present.
   Reuse the existing branches inside `dispatch_issue_by_id` (implementation
   dispatch, `_run_acceptance_gate_for_issue`, `_handle_direct_done_bypass`) but
   select the branch from `current_phase`, not from the Linear issue state.
2. Have each branch produce the `PhaseAdvanceResult` inline (next_phase, status,
   reason, human_action, workspace_path, ops_snapshot_path).
3. Rewrite `cli.py::run_phase_advance` to call `advance` and write the returned
   result. Delete `_phase_result_from_state` and `_phase_result_from_dispatch`.
4. Keep `dispatch_issue_by_id` for the legacy direct/`make once` path until
   Stage 3 retires it.

### Acceptance criteria

- **Behavior split by phase (4/4 required):** a `test_phase_advance` unit test
  drives `advance` with each `current_phase` and asserts the Performer runs a
  different branch per phase (implementation vs gate vs rework), using an
  injected fake runner/tracker. Passing `REVIEWING` must not run implementation.
- **Scaffolding gone (hard gate):** `grep -n "_phase_result_from_state\|_phase_result_from_dispatch" packages`
  returns nothing.
- **Contract clean:** `PhaseAdvanceResult` produced by `advance` never contains
  `thread_id`; assert in test.
- **No regression:** `make test` green; `test_import_boundaries` green.
- **Evidence:** exact pytest command + pass counts; the grep output; one sample
  `PhaseAdvanceResult` JSON per phase.

Score target: 4/4 (unit-level; real-run deferred to Stage 6).

---

## Stage 2 — Codex thread id lives in the workspace, best-effort resume

**Goal:** a per-issue Codex thread survives across phase calls via
workspace-owned state, resumed when possible, rebuilt when not.

### Work

1. Persist `thread_id` in workspace-owned state keyed by issue (extend the
   existing `codex_threads` persistence so the authoritative copy is under the
   issue workspace, not only in-process state).
2. In `advance`, before starting Codex: try `thread_resume(thread_id)`; on
   failure start a fresh thread seeded with git state + prior phase summary +
   `human_response`.
3. Record which path was taken (`resumed` vs `rebuilt`) in ops/trace, not in
   `PhaseAdvanceResult` and not in Conductor state.

### Acceptance criteria

- **Resume happy path (3/4+):** `test_phase_resume` — second `advance` for the
  same issue resumes the persisted thread id (assert `thread_resume` called with
  the stored id).
- **Rebuild fallback (3/4+):** when the fake SDK raises on resume, `advance`
  starts a new thread and still returns a valid `PhaseAdvanceResult`.
- **Try-token intact (hard gate):** `thread_id` still absent from
  `PhaseAdvanceResult`; Conductor store never persists a `thread_id` field
  (`grep -n "thread_id" packages/conductor` shows none in run/event schema).
- **Evidence:** pytest output; assertion of the resume call; the negative grep.

Score target: 3/4 (real Codex resume deferred to Stage 6).

---

## Stage 3 — Unify direct and managed on the phase machine

**Goal:** both modes drive the same reducer; only signal ingress differs. Retire
the parallel legacy driver.

### Work

1. Remove the legacy branch in `coordinate_background_once`
   (`_resume_pending_performer_work`, `_coordinate_gated_followup`) so direct
   mode also flows through `_start_due_orchestration_runs` + phase loop.
2. Managed ingress — "human answered": handle a pushed `human.answered` command
   in `handle_podium_ws_command` → `phase_reducer.human_completed`. Conductor
   stops polling Linear for child-issue Done in managed mode.
3. Direct ingress — add a Conductor-side Linear poll that maps new work →
   `dispatch_received` and resolved human child issues → `human_completed`.
4. Remove the `if not self._managed_mode_enabled(): return` short-circuit in
   `_coordinate_phase_human_actions`; instead select ingress (push vs poll) by
   mode while sharing the reducer.

### Acceptance criteria

- **Single driver (hard gate):** `coordinate_background_once` no longer calls
  `_resume_pending_performer_work` / `_coordinate_gated_followup`;
  `grep` confirms. Both modes reach `_start_due_orchestration_runs`.
- **Managed push (4/4):** `test_conductor_podium_channels` — a `human.answered`
  WS command transitions an `AWAITING_HUMAN` run to `QUEUED` without any Linear
  `fetch_child_issues` call (assert the tracker is not invoked).
- **Direct poll (3/4+):** `test_conductor_service` — a direct-mode tick with a
  Done human child issue transitions the run via `human_completed`.
- **Parity:** the same run fixture reaches `DONE` in both modes driving the same
  reducer.
- **Evidence:** pytest output; the negative greps; assertion that managed path
  makes zero Linear child-issue reads.

Score target: 3/4 (real dual-mode run deferred to Stage 6).

---

## Stage 4 — Tighten the managed token boundary

**Goal:** in managed mode, Conductor holds zero Linear credentials; the embedded
LinearClient is direct-mode only.

### Work

1. Gate the embedded `LinearClient` / `repository_handoff_tracker_factory`
   Linear access behind direct mode.
2. Confirm managed-mode Linear writes flow only through Performer → Podium proxy.
3. Managed Conductor config must not require or read a Linear API key.

### Acceptance criteria

- **Zero managed credentials (hard gate):** a managed-mode integration test runs
  a full queued→done cycle with **no** Linear credential configured on Conductor
  and succeeds.
- **No managed Linear calls (4/4):** assert Conductor makes no direct Linear
  GraphQL call in the managed path (spy/transport asserts zero calls); Performer
  proxy path handles all Linear writes.
- **Secret hygiene:** no Linear token appears in Conductor logs/API responses
  (existing `test_no_podium_memory_state` style check extended).
- **Evidence:** the credential-free run; the zero-call assertion; log scan.

Score target: 4/4.

---

## Stage 5 — Label simplification + migration

**Goal:** Linear labels project the new model; redundant axes removed.

### Work

1. Introduce `performer_api` `LabelScheme` collapsing to
   `performer:phase/*` + `performer:type/*` + `performer:gate/*` (+ score);
   demote `lifecycle/*`, `dispatch/*`, `retry/*`, redundant `human/*`,
   `type/task`, `type/acceptance` to ops/trace or issue-body content.
2. Point orchestrator label sync + `conductor_workflow` defaults at the scheme.
3. `tools/relabel_migration.py` mapping old→new on active issues, mirroring
   `tools/linear_project_issues.py`.
4. Update `AGENT.md` gate-tree rules and
   `docs/real-run-testing-guide.md` in lockstep.

### Acceptance criteria

- **Scheme completeness (4/4):** `test_label_scheme` — every status/kind/gate
  value maps to exactly one label; no cross-axis collision; removed families
  are not referenced (`grep` for `lifecycle/`, `dispatch/`, `retry/` in
  non-test src returns nothing).
- **Migration proven (3/4+):** run `relabel_migration.py` against the test
  project (HELL) and audit before/after label sets.
- **Docs consistent:** AGENT.md gate labels match the new scheme; real-run guide
  updated.
- **Evidence:** pytest output; before/after audit JSON paths; the negative grep.

Score target: 3/4 (full real-run label audit rolls into Stage 6).

---

## Stage 6 — Real-run acceptance

**Goal:** prove the behaviors that mocks cannot, per AGENT.md real-run rules.

### Work

Run the real Linear + real Codex scenarios from
`docs/real-run-testing-guide.md`, exercising: managed dispatch → phase machine →
gate tree → done; Performer crash → Conductor restart → resume; `needs_human` →
`awaiting_human` → human resolves child issue → resume; direct-mode poll path.

### Acceptance criteria (hard gates from AGENT.md)

- **Crash recovery (4/4):** kill Performer mid-`IMPLEMENTING`; Conductor
  restarts and the run reaches a terminal phase. Evidence: run state transitions
  + logs showing `performer.crashed` then recovery.
- **Human resume (4/4):** a real `[Human Action]` child issue is created with the
  correct type label; only moving it to `Done` resumes the run; parent comments
  do not resume. Evidence: Linear tree audit + resume event.
- **Thread resume (3/4+):** observe a real `thread_resume` across a phase
  boundary in Performer logs; rebuild fallback observed at least once.
- **No stuck states:** none of the AGENT.md stuck-state signals
  (`running=0 claimed=1`, phase/state divergence) appear; if one does, fix and
  rerun from a clean archived project.
- **Evidence bundle:** use `tools/real_run_evidence_bundle.py`; archive the test
  project before and after.

Score target: 4/4 on crash + human; 3/4+ on thread resume.

---

## Sequencing summary

1. **Stage 1** unlocks everything — without it the phase machine is inert.
2. **Stage 2** depends on 1 (phases must be real before per-phase threads mean
   anything).
3. **Stage 3** depends on 1 (both modes need the real phase executor).
4. **Stage 4** depends on 3 (ingress split must exist before removing managed
   credentials).
5. **Stage 5** depends on the phase machine being the source of truth so labels
   can safely become projections.
6. **Stage 6** validates 1–5 under real Linear + real Codex.

## Global invariants (must hold after every stage)

- `PhaseAdvanceResult` never carries `thread_id`.
- Conductor never imports Performer internals (`test_import_boundaries`).
- Managed Conductor holds no Linear credentials (from Stage 4 on).
- `make test` stays green.
- No secret values in logs or API responses.
