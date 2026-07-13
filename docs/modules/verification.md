# Module baseline: `verification`

Status: verification baseline amended by ADR-0006 on 2026-07-13. The local
boundary suites are implemented; real OAuth/Linear/Performer acceptance remains
external evidence.

## Purpose

The test suite is organized by product-module ownership, not as a second
workflow, acceptance, or audit product. Tests reuse fixtures where the setup is
genuinely shared and keep the behavior assertion with the owning module.

## Current Python module suites

| Area | Tests |
|---|---|
| Shared contracts | `test_minimal_performer_api.py`, `test_performer_api_control.py`, `test_package_boundaries.py` |
| Performer | `test_minimal_performer_turn.py`, `test_performer_backend_contract.py`, `test_performer_control_cli.py`, `test_performer_sdk_client.py` |
| Conductor workflow/runtime/API | `test_conductor_api.py`, `test_conductor_gate.py`, `test_conductor_linear.py`, `test_conductor_podium_sync.py`, `test_conductor_recovery.py`, `test_conductor_runtime.py`, `test_conductor_workflow.py`, `test_workflow_driver.py` |
| Podium runtime/storage | `test_podium_runtime_polling.py`, `test_podium_storage.py` |

`make test` is the canonical command because it sets the four package source
paths. The current suite is local/fake-based; it checks contracts, SQLite
state, HTTP route behavior, SQL statement shape, dispatch/blocker behavior,
and the Performer backend/control boundary plus pinned Codex adapter shape.

## Real-flow boundary

`tools/real_flow.py --phase all` is the single sanitized staged real E2E runner.
It records OAuth, Linear, Performer, and Overall reports under one `run_id`;
phase-only invocations remain diagnostic and are not acceptance evidence.
`tools/linear_fixture.py` owns project/issue/child reads and sanitized GraphQL
errors.

The Performer phase starts installed `performer control`, validates status and
manual Check through `performer_api`, and runs installed plan/execute/gate turn
processes with one temporary copy of the approved seed. Its fake executable
coverage lives in `tests/test_real_flow.py`; passing that local test does not
replace a real provider run.

Do not report a real Linear/OAuth/Performer flow as passed until a scoped test
project has executed the actual product path and its report contains the
observed parent/child relation, dispatch/epoch state, runtime logs, and result
evidence. `.env` values are never printed or committed.

## Checks by change type

- Contract or workflow change: focused owner tests, then `make test`.
- Shared/backend boundary change: control/turn contract tests, backend contract
  suite, package dependency/import guardrails, then `make test`.
- Performer provider SDK change: owning adapter tests plus control/turn contract
  tests; a real provider run remains external evidence.
- Conductor process/readiness change: fake installed Performer process tests;
  Conductor must not mock or import a provider SDK.
- Podium Web change: run Web test/lint/build/design checks and use a browser
  when visible behavior changes.
- Linear/OAuth/polling change: local tests are necessary but do not replace a
  clean scoped real-flow verification.
