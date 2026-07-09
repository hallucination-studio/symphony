# Runtime Profiles And Backends

## Purpose

Runtime profiles tell Conductor how to prepare each mode. Backend selection is
orthogonal to mode: `plan`, `execute`, and `verify` define what kind of work is
allowed; backend `kind` defines which implementation runs it.

The first managed configuration uses Codex for `plan` and `execute`, and
`local-verifier` for `verify`.

## Configuration Channel

Podium pushes one versioned runtime config envelope per runtime group. The
envelope carries scheduler policy and per-mode profiles. Conductor accepts only
higher versions, persists the active config, and exposes the active version in
the pipeline view.

Stale or invalid config is rejected with a sanitized reason. Managed mode keeps
the last valid config when Podium is temporarily unreachable, and surfaces when
it is using a local default.

## Profile Shape

Each mode has one active profile:

```json
{
  "name": "codex-execute",
  "mode": "execute",
  "backend": {"kind": "codex"},
  "settings": {
    "codex_home_source": "$SYMPHONY_E2E_CODEX_HOME_SEED"
  }
}
```

Settings may reference environment variables. Browser responses and logs render
only sanitized settings, never resolved secret values.

## Per-Mode Isolation

Conductor materializes a dedicated runtime home for each mode/backend under the
managed instance state:

```text
runtime-homes/
  plan/codex/
  execute/codex/
  verify/local-verifier/
```

Codex-backed profiles receive isolated `CODEX_HOME` copies. Managed mode must
not fall back to the operator's global `~/.codex`. Missing or invalid managed
homes are terminal setup failures with visible error state.

Mode-home isolation is necessary but not sufficient for verifier isolation.
Verifier workspace isolation is owned by the verification handoff and uses a
fresh disposable workspace for each verify attempt.

## Backend Interface

Backends implement the mode lifecycle behind a small interface:

```text
prepare_environment(profile, mode) -> runtime_env
start_attempt(input)               -> attempt_handle
stream_events(handle)              -> progress events
cancel(handle)
collect_artifacts(handle)          -> artifact manifest
```

Scheduler and pipeline state logic depend on mode requirements, not backend
internals. Backend-specific behavior stays in backend adapters.

## Mode Requirements

```text
plan:
  structured output required
  graph writes are proposal-only

execute:
  workspace and shell required
  may write patch and evidence artifacts

verify:
  workspace and shell required
  may not write implementation patches
  may write only verifier evidence and verdict
```

A backend that cannot satisfy a mode's requirements is ineligible for that
mode.

## Thread Identity

Backends that expose conversation or run identity store it as `thread_id` on the
attempt record and in the Linear attempt comment. `thread_id` is audit metadata;
it is not scheduling state and must not be parsed from Linear.

Retry attempts receive new attempt ids and may receive new backend thread ids.
The durable attempt record remains the source of truth.

## Runtime Permissions

Planner runtime may propose graph and gate changes only. Executor runtime may
modify code and publish evidence. Verifier runtime may read the verification
input, run gates, and emit a verdict. None of the modes can mutate another
mode's artifacts, frozen gates, policy, or durable verdicts directly.

## Verification

Acceptance evidence must show the active config version, per-mode profile names,
backend kinds, sanitized settings, staged runtime home paths, absence of global
Codex-home fallback, attempt `thread_id` capture when available, and visible
failure state when profile materialization fails.
