# Minimal Polling Workflow Checklist

Status: implementation slices complete locally; real Linear/OAuth/Codex flow
is pending an environment with approved credentials. The user approved the
hard break: Linear and Podium Web behavior stay, workflow internals become one
sequential parent/Sub Issue/Gate flow, checkpoint groups and cross-model
acceptance are removed, and old tests/tools may be rebuilt.

## Fixed product decisions

- [x] Linear OAuth, project selection, cursor polling/checkpoints, delegation
      epochs, dispatch routing, binding, labels, proxy, and visible failures stay.
- [x] Podium Web routes, onboarding, auth, actions, responses, and visual
      behavior stay; browser secrets remain server-side.
- [x] Parent plan creates real ordered Linear Sub Issues.
- [x] Execution is strictly sequential; no DAG, parallel, branch, join, or
      integration queue.
- [x] A child reaches Done only after all verification commands and one
      read-only Codex Gate pass.
- [x] Gate evidence keeps score, rubric, threshold, weights, provenance,
      catalog, manifest, and artifact references.
- [x] One failed gate may rework once; the second failure blocks visibly.
- [x] Runtime approval/tool-input waits stay durable and create `[Human Action]`
      Linear children; checkpoint groups are deleted.
- [x] No cross-model reviewer or second acceptance scheduler.

## Implemented module slices

- [x] `performer-api`: compact workflow, turn, runtime, and validation contracts;
      old `managed_runs*` exports removed.
- [x] `performer`: one fenced `plan|execute|gate` request/result process,
      isolated CODEX_HOME, changed-file scope, event capture, and sanitized
      failures.
- [x] `conductor`: one durable `workflow.db`, ordered plan/Sub Issue flow,
      plan approval, execute/rework, command + Codex Gate evidence, parent
      completion, runtime waits, and stale-fence rejection.
- [x] `podium`: HTTP command lease/ack/report polling; socket routes,
      wake commands, historical log fetch, and duplicate runtime channel are
      removed without changing Linear control-plane behavior.
- [x] `podium-web`: old fragmented tests removed and rebuilt around shared
      setup with `App`, API client, Setup, and Product Pages module suites.
- [x] `tools`: old scenario/observer/auditor tree removed; only
      `tools/real_flow.py` and `tools/linear_fixture.py` remain.
- [x] Docs: module baselines plus concise architecture/workflow/real-flow docs
      record the ownership and deletion boundary.

## Verification completed locally

- [x] `make test` — 30 Python tests passed.
- [x] Python package compilation and tool import smoke passed before this slice.
- [x] `git diff --check` passed before this documentation/tool slice.
- [ ] `cd packages/podium/web && npm run test && npm run lint && npm run build`
      (run after the compact Web suite is committed).
- [ ] `tools/real_flow.py` against a clean Linear project, Podium, Conductor,
      and staged Codex home.

## Remaining operational work

- [ ] Run the real happy path: OAuth/project/binding -> delegated parent ->
      polling dispatch -> plan approval -> ordered Sub Issues -> execute ->
      command checks + Codex Gate -> parent Done.
- [ ] Run one failed-gate path and confirm the sanitized reason is identical in
      SQLite, logs, Linear, and Podium.
- [ ] Confirm Podium PostgreSQL migration preserves users, installations,
      selected projects, Conductors, and bindings in the deployment database.
- [ ] Archive any old local Conductor workflow database before deploying the new
      `workflow.db` schema.

## Stop conditions

Stop and revise the slice if a change drops Linear business behavior, changes a
Podium Web action/response, lets a child or parent bypass the Gate, allows a
stale result to mutate state, leaks a secret, or reintroduces a DAG,
checkpoint-group layer, cross-model reviewer, or second scheduler.
