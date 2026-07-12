# Minimal Polling Workflow Checklist

Status: local MVP acceptance closure is complete; the normalized
Podium-managed Codex profile/local-login design is awaiting user approval.
No implementation of the rejected single-table sketch is retained. External
Linear/OAuth/Codex verification remains blocked until the approved design is
implemented and the staged credentials/services are exercised. This checklist
is the active scope ledger;
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
- [ ] Replace the removed profile compatibility value with layered Podium
  Performer profiles -> runtime profiles/revisions plus a Performer binding
  reference; do not widen `project_bindings` with TOML or credential fields.
- [x] Remove persisted runtime-group ownership; retain the deterministic public
  alias `group_{conductor_id}`.
- [x] Collapse Conductor smoke/command wrappers into their unique owners.
- [x] Enforce active Linear blockers before dispatch lease and refresh cleared
  blockers after a complete reconciliation pass.
- [x] Repair the direct pinned Codex SDK stream contract and inline its one-use
  runtime mixin into `CodexSdkClient`.
- [x] Record one baseline document per module under `docs/modules/`.
- [x] Merge the one-consumer Conductor service-view mixin into
  `conductor_service.py`.
- [x] Remove the `Workflow` forwarding facade; `ConductorStore` is the sole
  durable workflow-transition owner.
- [x] Remove unlinked duplicate workflow/acceptance and agent-guidance docs.
- [x] Replace obsolete Web, installer, security, and Linear-projection claims
  with the current module-owned baseline.

## Remaining code slices

- [x] Simplify remaining one-use Conductor service/view helpers where behavior
  ownership is demonstrably singular.
- [x] Audit remaining tools/docs/legacy planning artifacts without changing
  Linear or Web behavior; no tracked disconnected artifact was found that is
  safe to remove.
- [x] Make retained acceptance evidence readable in the operator report and
  Linear projection using existing owners; do not create a new evidence runner
  or child-issue tree without explicit approval.
- [x] Reconcile the written Gate rule with the retained product contract:
  commands must pass, Codex must return `passed=true`, and the score must meet
  the threshold. No Gate behavior was changed; the existing threshold test
  remains the regression guard.

## MVP acceptance closure slice

- **Authorized:** prove one successful sequential parent/task/Gate closure;
  one Gate rework followed by a second-failure block; duplicate-result
  idempotency; stale-result rejection; sanitized runtime waits, failures, and
  logs; and one real Linear/OAuth/Codex flow through `tools/real_flow.py`.
- **Required consequences:** terminal attempt results cannot be applied twice;
  stale attempts cannot mutate the current task; runtime output and wait/failure
  reasons use the existing sanitized product surfaces; every accepted claim has
  focused test or real-flow evidence.
- **Out of scope:** changing the Gate threshold rule, adding a new endpoint or
  scheduler, changing Linear/Web vocabulary, or creating a second E2E runner.
- **Assumptions requiring approval:** none.
- **Deferred ideas:** richer real-flow orchestration automation and optional Web
  rendering of detailed evidence remain outside this closure slice.

## Podium-managed Codex configuration/local-login slice ledger (design pending)

- **Authorized:** design a reusable Podium Performer-profile wrapper that
  references runtime profiles/revisions, separate credential metadata/reference
  records, and Conductor-local selected OAuth/API-key slots for isolated
  Performer attempts. Official `codex login` ChatGPT OAuth without an API token
  is supported.
- **Required consequences:** layered Performer/runtime profile facts,
  immutable revisions, credential metadata, and Performer binding; strict
  TOML/secret validation; durable revision/hash/policy; idempotent/stale
  command handling; isolated attempt materialization; sanitized
  readiness/failure fields; local credentials kept outside Podium; focused
  tests and real-flow evidence.
- **Out of scope:** sending `auth.json`, keyring exports, API keys, or access
  tokens through Podium; a Podium credential vault; a second runtime transport;
  a new scheduler; or detailed credential rendering in Web/Linear.
- **Assumptions requiring approval:** the ADR-0004 layered table shape, local-only
  credentials, and file/directory profile provisioning listed in its approval
  questions. No production implementation may start before approval.
- **Deferred ideas:** KMS-backed Podium API-key storage, browser editing UI,
  and a managed credential brokerage require a separate product decision.

## Current evidence-projection slice ledger

- **Authorized:** expose the already-retained acceptance catalog, rubric,
  provenance, manifest, artifact, and Gate facts through the existing
  authenticated managed-runs report and existing Linear Gate comment.
- **Required consequences:** write bounded, sanitized local Gate details after
  the decision and derive one revision-aware summary; prevent raw command
  output, findings, secret-like values, and artifact/manifest locations from
  entering Podium or Linear.
- **Out of scope:** new endpoints, Web layout changes, new child issues,
  artifact download, manifest generation, a new verifier, another scheduler,
  cross-model review, or a Gate-rule change.
- **Assumptions requiring approval:** none. Existing `score >= threshold`
  behavior remains unchanged, and absent production manifest refs stay absent.
- **Deferred ideas:** rendering the optional summary in the current Web page,
  generating manifests, and allowing task identity changes across plan
  revisions all belong to separately approved product slices.

## Verification status

- [x] `make test` — 115 Python tests passed, including the full success closure,
      Gate rework/block, duplicate/stale result, and runtime redaction cases.
- [x] `cd packages/podium/web && npm run test && npm run lint && npm run
      design:lint && npm run build` — 27 Web tests passed; lint/build clean
      (design lint: 0 errors, 0 warnings).
- [x] `tools/real_flow.py --offline` — staged Codex seed preflight passed;
      report: `.test-real-flow/mvp-offline-report.json`.
- [x] MVP acceptance closure evidence for duplicate/stale result handling and
      runtime wait/failure/log redaction is covered by the 113-test suite.
- [ ] Real Linear/OAuth/Codex product flow — current configured project probe
      reaches Linear but returns sanitized `linear_request_failed:http_401`;
      evidence: `.test-real-flow/mvp-real-probe.json`. The standard report also
      records missing project/Podium environment when those values are absent:
      `.test-real-flow/mvp-real-report.json`.

## Stop conditions

Stop and revise the slice if it drops Linear business behavior, changes a
Podium Web action/response, lets a child or parent bypass the Gate, permits a
stale result to mutate state, leaks a secret, or reintroduces checkpoint,
DAG/parallel, cross-model, or second-scheduler behavior.
