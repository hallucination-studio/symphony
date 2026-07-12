# Minimal Polling Workflow Rebuild

Status: active hard-cut implementation ledger, approved by the user on
2026-07-12. This replaces the earlier expansion-oriented and intermediate
contraction plans. [`spec.md`](spec.md) is the product contract;
[`todo.md`](todo.md) is the current work checklist; [`docs/modules`](../docs/modules/README.md)
records one design baseline per module.

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
- The remaining Gate-rule wording conflict is intentionally unresolved:
  `spec.md` says commands plus `passed=true`; current code also enforces
  `score >= threshold`. No behavior change may resolve it without an explicit
  product decision.

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

## Remaining Work

1. Keep the sanitized evidence projection contract covered by the existing
   operator and Linear surfaces. No new runner, endpoint, or evidence child-issue
   tree is allowed.
2. Resolve the Gate threshold rule explicitly before changing its behavior.
3. Run a scoped real Linear/OAuth/Codex product flow after the local rebuild.
   The staged Codex preflight passes, but the sourced environment has no
   project slug or Podium URL; `.test-real-flow/mvp-real-report.json` records
   the sanitized preflight blocker.
   `tools/real_flow.py` remains a strict
   preflight/observation tool, not proof of a complete external flow.

## Verification Rule

Each implementation slice must have an empty assumptions list, trace its old
owner to zero callers, keep its surviving owner explicit, pass focused module
tests and `make test`, and be committed independently. Browser source changes
also require the Web test, lint, design-lint, and build commands. No local test
run implies a real Linear/OAuth/Codex pass.
