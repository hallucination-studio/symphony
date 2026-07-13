# Module baseline: `verification`

Status: local verification baseline, 2026-07-12.

## Purpose

The test suite is organized by product-module ownership, not as a second
workflow, acceptance, or audit product. Tests reuse fixtures where the setup is
genuinely shared and keep the behavior assertion with the owning module.

## Current Python module suites

| Area | Tests |
|---|---|
| Shared contracts | `test_minimal_performer_api.py`, `test_package_boundaries.py` |
| Performer | `test_minimal_performer_turn.py`, `test_performer_sdk_client.py` |
| Conductor workflow/runtime/API | `test_conductor_api.py`, `test_conductor_gate.py`, `test_conductor_linear.py`, `test_conductor_podium_sync.py`, `test_conductor_recovery.py`, `test_conductor_runtime.py`, `test_conductor_workflow.py`, `test_workflow_driver.py` |
| Podium runtime/storage | `test_podium_runtime_polling.py`, `test_podium_storage.py` |

`make test` is the canonical command because it sets the four package source
paths. The current suite is local/fake-based; it checks contracts, SQLite
state, HTTP route behavior, SQL statement shape, dispatch/blocker behavior,
and the direct pinned-SDK adapter shape.

## Real-flow boundary

`tools/real_flow.py --phase all` is the single sanitized staged real E2E runner.
It records OAuth, Linear, Performer, and Overall reports under one `run_id`;
phase-only invocations remain diagnostic and are not acceptance evidence.
`tools/linear_fixture.py` owns project/issue/child reads and sanitized GraphQL
errors.

Do not report a real Linear/OAuth/Codex flow as passed until a scoped test
project has executed the actual product path and its report contains the
observed parent/child relation, dispatch/epoch state, runtime logs, and result
evidence. `.env` values are never printed or committed.

## Checks by change type

- Contract or workflow change: focused owner tests, then `make test`.
- Performer SDK change: `test_performer_sdk_client.py` plus a local request/
  result contract test; a real Codex run remains external evidence.
- Podium Web change: run Web test/lint/build/design checks and use a browser
  when visible behavior changes.
- Linear/OAuth/polling change: local tests are necessary but do not replace a
  clean scoped real-flow verification.
