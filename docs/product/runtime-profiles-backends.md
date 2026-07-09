# Runtime Profiles And Backends

## Purpose

Runtime profiles tell Conductor how to prepare each managed-run role. Backend
selection is orthogonal to role: `plan`, `work_item`, and `verify` define what
kind of work is allowed; backend `kind` defines which implementation runs it.

The first managed configuration uses Codex for `plan` and `work_item`, and may
use either Codex or `local-verifier` for `verify`.

## Configuration Channel

Podium pushes one versioned runtime config envelope per runtime group. The
envelope carries managed-run policy and per-role profiles. Conductor accepts only
higher versions, persists the active config, and exposes the active version in
the managed-runs view.

Stale or invalid config is rejected with a sanitized reason. Managed-run
execution keeps the last valid config when Podium is temporarily unreachable,
and surfaces when it is using a local default.

## Profile Shape

Each role has one active profile:

```json
{
  "name": "codex-work-item",
  "role": "work_item",
  "backend": "codex",
  "settings": {
    "codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SEED"
  }
}
```

Settings may reference environment variables. Browser responses and logs render
only sanitized settings, never resolved secret values.

## Per-Role Isolation

Conductor materializes a dedicated runtime home for each role/backend under the
managed instance state:

```text
runtime-homes/
  plan/codex/
  work_item/codex/
  verify/local-verifier/
```

Codex-backed profiles receive isolated `CODEX_HOME` copies. Managed execution
must not fall back to the operator's global `~/.codex`. Missing or invalid
managed homes are terminal setup failures with visible error state.

Role-home isolation is necessary but not sufficient for verifier isolation.
Verifier workspace isolation is owned by the managed-run verification handoff and
uses a fresh disposable worktree for each verification turn with mutation
detection.

## Backend Interface

Backends implement the managed-run role lifecycle behind a small interface:

```text
prepare_environment(profile, role) -> runtime_env
start_turn(input)                  -> turn_handle
stream_events(handle)              -> progress events
cancel(handle)
collect_artifacts(handle)          -> artifact manifest
```

Managed-run state logic depends on role requirements, not backend internals.
Backend-specific behavior stays in backend adapters.

## Role Requirements

```text
plan:
  structured output required
  file changes are forbidden
  output is a structured plan payload

work_item:
  workspace and shell required
  may write implementation patches within accepted file scope
  output is WorkItemResult

verify:
  workspace and shell required
  may not write implementation patches
  may write only verifier evidence and verdict
```

A backend that cannot satisfy a role's requirements is ineligible for that role.

## Thread Identity

Backends that expose conversation or run identity store it as `thread_id` on the
managed run and turn result. `thread_id` is audit metadata; it is not scheduling
state and must not be parsed from Linear.

Retries receive new turn ids and may receive new backend thread ids. Durable
managed-run state remains the source of truth.

## Runtime Permissions

Planner runtime may propose managed-run plan changes only. Work-item runtime may
modify code within accepted scope and publish evidence. Verifier runtime may
read the verification input, run checks, and emit a verdict. No role can mutate
another role's artifacts, accepted plan versions, policy, or durable verdicts
directly.

## Verification

Acceptance evidence must show the active config version, per-role profile names,
backend kinds, sanitized settings, staged runtime home paths, absence of global
Codex-home fallback, turn `thread_id` capture when available, and visible
failure state when profile materialization fails.
