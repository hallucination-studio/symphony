# Minimal Polling Workflow Rebuild

Status: active hard-cut implementation ledger, approved by the user on
2026-07-12. This replaces the earlier expansion-oriented and intermediate
contraction plans. [`spec.md`](spec.md) is the product contract;
[`todo.md`](todo.md) is the current work checklist; [`docs/modules`](../docs/modules/README.md)
records one design baseline per module.

The non-secret Codex profile slice continues to follow
[`ADR-0004`](../docs/decisions/0004-normalized-codex-profiles-and-credential-references.md),
while credential ownership, selection, readiness, and reporting are superseded
by the approved
[`ADR-0005`](../docs/decisions/0005-conductor-owned-opaque-codex-credentials.md).
ADR-0005 implementation and real-flow verification are active work.

## Outcome

```text
delegated Linear parent
  -> ordered Linear Sub Issues
  -> sequential fenced Codex turns
  -> verification commands + one read-only Codex Gate
  -> child Done, one rework, or visible block
  -> parent Done
```

Podium keeps its full Linear control-plane and Web business behavior. The only
runtime transport is authenticated HTTP polling; the retained local Conductor
HTTP API is separate from that transport.

## Scope Ledger

### Authorized

- Hard-cut obsolete local/runtime state with no migration or compatibility
  layer.
- Delete checkpoint groups, graph/dependency/parallel/branch/join workflow,
  cross-model review, and a second acceptance scheduler.
- Delete disconnected abstractions, stale documentation, unused tools, and
  duplicate tests; rebuild module-oriented tests without duplicate setup.
- Simplify role-owned code only after tracing callers and preserving behavior.

### Required consequences

- Preserve Linear OAuth, token refresh, application selection, full cursor
  pagination/checkpoints, delegation epochs, dispatch deduplication, bindings,
  labels, proxying, parent/Sub Issue projection, and visible failures.
- Preserve Podium Web routes, auth, onboarding, actions, response contracts,
  visual behavior, and browser secret boundaries.
- Preserve isolated `CODEX_HOME`, one-shot Performer request/result files,
  fencing, retries, structured events, logs, sanitized errors, and durable
  sequential workflow transitions.
- Retain plan revisions/approval, risks/architecture decisions/open questions,
  acceptance catalog, score/rubric/threshold/weight/provenance, manifest, and
  artifact contracts. These are evidence data, not another scheduler.

### Out of scope

- WebSocket runtime transport, old runtime groups, generic protocol engines,
  compatibility shims, legacy state migration, speculative backends, a visual
  redesign, and product cross-model acceptance.
- Changing a Linear or Podium Web business contract merely to reduce lines.

### Approved assumptions

- Strict task order, one automatic rework, hard state cutover, no old-data
  migration, and no cross-model/second acceptance scheduler are approved.
- The Gate rule is documented consistently with the retained implementation:
  commands pass, Codex returns `passed=true`, and score meets threshold. This
  documentation reconciliation does not change Gate behavior.
- Managed Codex authentication may be ChatGPT OAuth from `codex login` without
  an API token. Multiple local OAuth/API-key slots are selected by id;
  credentials remain outside the Podium command payload.

## Current Module Baselines

| Module | Baseline | Current simplification direction |
|---|---|---|
| `performer-api` | [`performer-api.md`](../docs/modules/performer-api.md) | shared minimal contracts only |
| `performer` | [`performer.md`](../docs/modules/performer.md) | direct pinned SDK, one fenced turn |
| `conductor` | [`conductor.md`](../docs/modules/conductor.md) | single SQLite workflow owner and sequential driver |
| `podium` | [`podium.md`](../docs/modules/podium.md) | retain Linear/Web control plane, remove duplicate internals |
| `podium-web` | [`podium-web.md`](../docs/modules/podium-web.md) | preserve product UX, delete only unused implementation seams |
| verification | [`verification.md`](../docs/modules/verification.md) | reusable module tests plus strict preflight |

## Completed Slices

- Replaced the WebSocket runtime path with HTTP report, command, and dispatch
  polling while retaining local Conductor HTTP APIs.
- Removed persisted runtime-group ownership and retained
  `group_{conductor_id}` only as a presentation alias.
- Collapsed the Conductor workflow facade into its SQLite store and removed
  obsolete coordination, service-view, response-adapter, and dead instance
  layers.
- Kept a direct pinned Codex SDK path and removed unused title, callback,
  return-envelope, and compatibility-result paths without losing events,
  waits, retries, fences, or errors.
- Consolidated Podium SQL/schema and Linear installation-cutover ownership.
- Removed unused Podium Web seams and co-located one-use UI helpers with their
  owners without changing routes or visible behavior.
- Replaced duplicate/obsolete product guidance with concise module baselines.
- Bound managed-run snapshots to the current binding/configuration, bounded and
  sanitized their browser projection, and made unbind/rebind discard old local
  workflow state atomically.
- Inlined the single-owner Conductor runtime-metrics projection and retained
  behavior with a public `instance_runtime()` regression test.
- Audited tracked tools and planning/module docs; the only real-flow tools are
  the supported `real_flow.py` runner and its `linear_fixture.py` helper, and
  removed-behavior docs are intentional product constraints.
- Updated the real-flow fixture for OAuth Bearer headers, current Linear
  `Project.teams` schema, bounded HTTP status errors, and regression coverage.

## Remaining Work

1. Hard-cut Podium credential persistence and credential-bearing shared command
   fields while retaining current non-secret profile documents and binding
   generation/hash fencing.
2. Implement Conductor-owned opaque credential slots, local selection,
   isolated attempt materialization, bounded live checks, and safe OAuth refresh
   copy-back without parsing `auth.json`.
3. Implement the outbound-only ephemeral Podium/Conductor inventory and check
   relay without durable credential-management state.
4. Keep the sanitized evidence projection contract covered by the existing
   operator and Linear surfaces. No new runner, endpoint, or evidence child-issue
   tree is allowed.
5. Run the single staged real Linear/OAuth/Codex batch after the local rebuild.
   `tools/real_flow.py --phase all` records all three prerequisite phases and
   Overall under one `run_id`; current external blockers remain visible in
   the newest `.test-real-flow/batch-report-*.json` and do not count as
   acceptance.

## ADR-0005 implementation scope ledger

### Authorized

- Remove Podium credential rows, binding credential references, and credential
  fields from the shared `project.configure` contract.
- Add Conductor-owned opaque Codex credential slots supporting official OAuth
  and API-key login state through the same file-based path.
- Add local init, live check, and selection commands plus isolated attempt
  materialization and safe refresh copy-back.
- Add an ephemeral outbound-only Podium/Conductor inventory and check relay.
- Update the existing real-flow runner to reuse fixed test slots and model
  `gpt-5.4`.

### Required consequences

- Managed runtime TOML requires `cli_auth_credentials_store = "file"`.
- Podium retains only non-secret runtime and Performer profiles; it stores no
  slot inventory, selection, auth method, readiness, or check result.
- Conductor is the sole durable owner of slot metadata and selection, and every
  Performer attempt receives a fresh isolated `CODEX_HOME`.
- OAuth refresh copy-back is locked, bounded, atomic, path-safe, and opaque.
- Live responses are bounded, sanitized, no-store, single-delivery, and not
  written to runtime commands or other durable Podium state.

### Out of scope

- Remote credential mutation, Podium credential vaults, KMS/keyring extraction,
  parsing `auth.json`, a second runtime transport, a second E2E runner, or an
  additional scheduler.

### Assumptions requiring approval

- None.

### Deferred ideas

- Durable multi-process live relay, remote slot lifecycle management, cached
  readiness/account discovery, and managed credential brokerage.

## Verification Rule

Each implementation slice must have an empty assumptions list, trace its old
owner to zero callers, keep its surviving owner explicit, pass focused module
tests and `make test`, and be committed independently. Browser source changes
also require the Web test, lint, design-lint, and build commands. No local test
run implies a real Linear/OAuth/Codex pass.
