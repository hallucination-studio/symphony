# Minimal Polling Workflow Checklist

Status: implementation is in progress. Local module slices are committed;
external Linear/OAuth/Codex verification remains pending a clean scoped project
and approved runtime environment. This checklist is the active scope ledger;
`tasks/spec.md` remains the product contract.

## Fixed product decisions

- [x] Preserve Linear OAuth, selected projects, paginated polling/checkpoints,
  delegation epochs, dispatch routing, bindings, labels, proxy, and visible
  failures.
- [x] Preserve Podium Web routes, onboarding, authentication, actions,
  responses, visual behavior, and browser secret boundaries.
- [x] Use an ordered parent -> Linear Sub Issues -> sequential Codex workflow.
- [x] Keep plan revision/approval and retained score/rubric/threshold/weight/
  provenance/catalog/manifest/artifact contracts.
- [x] Remove checkpoint groups, DAG/parallel/branch/join behavior, cross-model
  review, and a second acceptance scheduler.
- [x] Keep command checks plus one read-only Codex Gate, one automatic rework,
  then visible blocking on the second failure.
- [x] Hard-cut old local/runtime state: fresh schemas only, no migration.

## Implemented simplification slices

- [x] Consolidate Conductor persistence into one fresh `workflow.db`.
- [x] Remove Podium runtime profile registry and Conductor profile input.
- [x] Remove persisted runtime-group ownership; retain the deterministic public
  alias `group_{conductor_id}`.
- [x] Collapse Conductor smoke/command wrappers into their unique owners.
- [x] Enforce active Linear blockers before dispatch lease and refresh cleared
  blockers after a complete reconciliation pass.
- [x] Repair the direct pinned Codex SDK stream contract and inline its one-use
  runtime mixin into `CodexSdkClient`.
- [x] Record one baseline document per module under `docs/modules/`.

## Remaining code slices

- [ ] Simplify remaining one-use Conductor service/view helpers where behavior
  ownership is demonstrably singular.
- [ ] Audit and remove remaining disconnected tools/docs/legacy planning
  artifacts without changing Linear or Web behavior.
- [ ] Make retained acceptance evidence readable in the operator report and
  Linear projection using existing owners; do not create a new evidence runner
  or child-issue tree without explicit approval.
- [ ] Reconcile the written Gate rule: the spec says commands + Codex
  `passed=true`, while current retained code also applies `score >= threshold`.
  Do not change the product rule until it is explicitly resolved.

## Verification status

- [x] `make test` — 63 Python tests passed after the current SDK/runtime-group
  slices.
- [ ] `cd packages/podium/web && npm run test && npm run lint && npm run build`
      after backend-contract/doc changes settle.
- [ ] `tools/real_flow.py` preflight and a scoped real product flow. The current
      tool is preflight only and cannot prove the full managed-run path.

## Stop conditions

Stop and revise the slice if it drops Linear business behavior, changes a
Podium Web action/response, lets a child or parent bypass the Gate, permits a
stale result to mutate state, leaks a secret, or reintroduces checkpoint,
DAG/parallel, cross-model, or second-scheduler behavior.
