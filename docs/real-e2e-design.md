# Real E2E Design: OAuth, Linear, Performer, and MVP Closure

Status: **implemented agent execution contract**. This document is the source
of truth for the staged real E2E runner and acceptance rubric. It authorizes the
single `tools/real_flow.py` batch implementation, but never an OAuth
reauthorization, a second runner, or a secret-bearing credential transport.

The purpose of the split is to collect a complete failure set before the
overall run. The three prerequisite phases are logically isolated, but a real
E2E invocation must execute **all three phases in one batch and one `run_id`**.
An agent must not run OAuth, stop, fix one issue, run Linear, stop, fix one
issue, and so on. The Overall phase is executable only after all three
prerequisite gates pass in that same batch.

## 1. Non-Negotiable Rules

1. The phases are **OAuth**, **Linear**, and **Performer**. The final phase is
   **Overall MVP**. `OA` in discussion means OAuth.
2. The only supported real-flow entrypoint is `tools/real_flow.py`. Do not add
   a scenario registry, observer, auditor, alternate E2E CLI, or shell script
   that duplicates its report logic. If phase selection is needed, extend this
   entrypoint with the phase contract below.
3. A real E2E invocation is the `all` batch: it runs OAuth, Linear, and
   Performer in that order under one `run_id`, then evaluates Overall. The
   phases may have isolated processes and artifacts, but they are not separate
   bug-fix runs.
4. The phase runner must execute every check in every phase and write every
   phase report even when an earlier check fails. It must not stop at the first
   failure.
5. `all` records the complete failure set from all three phases and skips
   Overall with `blocked_by` when any prerequisite failed. A phase-only command
   may exist for diagnosis after the batch, but it is not acceptance evidence
   and cannot replace the batch run.
6. No phase may call the OAuth start route or open the Linear consent screen.
   The existing Podium installation is reused. A missing, expired, or rejected
   installation is a failed prerequisite with `linear_reauthorization_required`;
   it is never repaired by a hidden reauthorization.
7. The Linear token from `.env` is a fixture credential only. It may be used by
   `tools.linear_fixture.LinearFixture` for explicit Linear reads/writes. It
   must not be placed in Podium project configuration, Conductor settings,
   Performer environment, a report, a log, a Linear comment, or a browser
   response. The managed path continues to use the existing Podium OAuth
   installation and runtime bearer tokens.
8. The Codex seed is a fixed, approved staged copy. Every phase receives a
   byte-identical copy in its own temporary `CODEX_HOME`; no phase reads
   `~/.codex`, and no phase copies an unapproved file.
9. The Performer phase reads both `config.toml` and opaque login state only
   from the fixed test seed directory. The config must use `model = gpt-5.4`
   and `cli_auth_credentials_store = file`; provider details are whatever the
   operator explicitly staged in that test-only config. Podium profiles must
   not override the Performer-phase config.
10. A local pytest pass is not a real E2E pass. A real phase requires running
   services, real HTTP/GraphQL responses, durable state, logs, and archived
   sanitized evidence.
11. A known external failure must remain visible. In particular, `401` from
    the `.env` Linear token and `502` from the Codex provider are failures, not
    timeouts, retries without a final reason, or inferred passes.

## 2. Shared Run Contract

### 2.1 Inputs

Load `.env` once in the parent shell with `set -a && source .env && set +a`.
The runner reads these values through `tools.linear_fixture.required_environment()`
and the existing environment contract:

| Input | Required use | Forbidden use |
|---|---|---|
| `SYMPHONY_E2E_PODIUM_URL` | Podium HTTP/browser base URL | Writing a second service URL into reports |
| `SYMPHONY_E2E_PROJECT_SLUG` | Selected Linear project lookup | Using a label as the routing key |
| `SYMPHONY_E2E_CODEX_HOME_SEED` | Approved staged Codex seed | Falling back to `~/.codex` |
| `PODIUM_LINEAR_APP_ACCESS_TOKEN` | Direct fixture GraphQL only | Podium/Conductor/Performer managed auth |
| `PODIUM_PERFORMER_PROFILE_DIR` and `PODIUM_PERFORMER_PROFILE_NAME` | Podium service configuration used only by Overall | Overriding the independent Performer phase |
| `SYMPHONY_E2E_BROWSER_OBSERVATION_PATH` | Sanitized same-origin responses written by the browser skill | Reading/exporting cookies, localStorage, or bearer values |
| `SYMPHONY_E2E_CONDUCTOR_URL` | Read-only local Conductor observation after its own polling | Supplying a runtime bearer to the runner |
| `SYMPHONY_E2E_FIXTURE_REPOSITORY` | Explicit disposable Git workspace receiving the verifier scripts | Writing into an inferred customer repository |

`LINEAR_API_KEY` is unset for the Linear phase so that the phase cannot silently
use a different credential. The runner records only `token_present`, token
length, request status, and sanitized error code. It never records the value.

The browser skill writes the observation file by issuing same-origin `fetch`
requests from the already signed-in Podium page and saving only this shape:

```json
{
  "base_url": "http://127.0.0.1:8090",
  "captured_at": "2026-07-12T15:15:47.674Z",
  "observations": {
    "/api/v1/auth/me": {"status_code": 200, "payload": {"user": {"id": "...", "email": "..."}}}
  }
}
```

The runner rejects any observation containing credential fields or token-shaped
values. The file is an evidence handoff, not an authentication transport.

### 2.2 Run identity and directories

Each invocation creates one `run_id` and a fixed report root:

```text
.test-real-flow/<run-id>/
  manifest.json
  inputs.json                 # sanitized hashes and non-secret identifiers only
  oauth/report.json
  linear/report.json
  performer/report.json
  overall/report.json
  logs/podium.log
  logs/conductor.log
  logs/performer/<instance>/<attempt>.log
  requests/<run>/<attempt>/turn-request.json
  results/<run>/<attempt>/turn-result.json
  state/conductor/workflow.db
```

The manifest contains phase status, check names, observed identifiers,
configuration hashes, artifact paths, and failure groups. It must not contain
tokens, cookies, `auth.json` contents, raw command output, or a path that points
at a directory containing `auth.json`.

### 2.3 Phase result shape

Every phase writes a JSON report with this minimum shape:

```json
{
  "run_id": "...",
  "phase": "oauth|linear|performer|overall",
  "status": "passed|failed|blocked|skipped",
  "checks": [
    {
      "name": "stable_check_name",
      "passed": true,
      "required": true,
      "observations": {}
    }
  ],
  "failures": [
    {
      "group": "auth|linear|provider|binding|workflow|fence|redaction|evidence",
      "error_code": "...",
      "sanitized_reason": "...",
      "action_required": false,
      "retryable": false,
      "next_action": "..."
    }
  ],
  "artifacts": []
}
```

`passed` means every required check passed and all required artifacts exist.
`failed` means a phase executed but one or more required checks failed.
`blocked` means a prerequisite outside the phase prevents a meaningful run;
the concrete blocker is still listed. `skipped` is allowed only for Overall
when a prerequisite phase failed.

### 2.4 Batch command contract

The implementation of the runner must extend the existing `tools/real_flow.py`
parser with exactly this acceptance command; it must not create a second
entrypoint:

```bash
set -a && source .env && set +a
PYTHONPATH=tools .venv/bin/python tools/real_flow.py \
  --phase all \
  --project-slug "$SYMPHONY_E2E_PROJECT_SLUG" \
  --out .test-real-flow/batch-report.json
```

`--phase all` is the only acceptance value. It creates the `run_id`, runs
OAuth, Linear, Performer, and then Overall in that order. `--phase oauth`,
`--phase linear`, and `--phase performer` may be retained as diagnostic modes,
but those modes must reject acceptance scoring and must not overwrite a batch
report. Exit codes are fixed: `0` means all required phases and Overall passed;
`2` means a required check failed or Overall was blocked/skipped; `1` means
the runner itself failed before producing a valid phase report. Every exit code
must still leave the per-phase reports and sanitized artifact manifest.

`--out` is the final batch report file. The runner allocates a fresh
`.test-real-flow/<generated-run-id>/` artifact root beside it and writes the
per-phase reports there; `<generated-run-id>` is never a shell input or a
literal directory name.

The runner now implements the phase/all command above. A phase-only command is
diagnostic evidence only; the final acceptance unit remains one fresh `all`
batch with one `run_id`. Current external 401/502 blockers are recorded as
failures and cannot be converted into a phase pass.

## 3. Allowed Code and Test Entrypoints

Agents must call these existing surfaces. They must not reimplement equivalent
queries or state transitions in a new helper.

### 3.1 Real-flow and fixture code

- `tools.real_flow.run()` and `tools.real_flow._write_report()` own the
  preflight/report lifecycle. Private helpers may be called only from
  `tools/real_flow.py`; a phase implementation must not duplicate them.
- `tools.linear_fixture.LinearFixture.from_environment()` selects the `.env`
  fixture credential, and `LinearFixture.graphql()` performs the only direct
  fixture GraphQL transport.
- `LinearFixture.project(slug)`, `LinearFixture.issue(issue_id)`, and
  `LinearFixture.children(issue_id)` are the approved read helpers. All issue
  reads must request `parent { id identifier }` and use that explicit field.
- `LinearFixture.workflow_states(team_id)` resolves the team state ids needed
  by fixture mutations. `LinearFixture.create_parent_issue(...)` creates a
  parent with `parentId: null` and verifies the returned `parent` is null.
- Direct fixture mutations not covered by those helpers must go through
  `LinearFixture.graphql()` using the operation documents already used by
  `conductor.linear.ManagedRunLinearProxy`: `issueUpdate` and
  `commentCreate`. Do not add a second raw `httpx` client.

### 3.2 Podium surfaces

Use the running Podium HTTP API, not direct SQL, for external phase checks:

- `GET /api/v1/auth/me` from `register_auth_routes`.
- `GET /api/v1/linear/installations` from
  `register_linear_oauth_routes`.
- `GET /api/v1/linear/projects` from `register_linear_project_routes`.
- `GET /api/v1/runtimes` and `GET /api/v1/runtimes/{runtime_id}` from
  `register_runtime_identity_routes`.
- `PUT /api/v1/conductors/{conductor_id}/binding` from
  `register_conductor_binding_routes`.
- Runtime polling endpoints from `register_runtime_ops_routes`:
  `/api/v1/runtime/report`, `/api/v1/runtime/commands/lease`,
  `/api/v1/runtime/commands/ack`, `/api/v1/runtime/dispatches/lease`, and
  `/api/v1/runtime/dispatches/ack`.
- `GET /api/v1/managed-runs` and the instance log route from
  `register_runtime_ops_routes` for sanitized evidence.

The corresponding business owners that must remain the source of behavior are
`PodiumLinearTokenMixin.linear_access_token()` and
`linear_graphql_for_installation()`, `LinearReconciler.reconcile_once()`,
`PodiumRuntimeMixin.apply_runtime_report()`, and the runtime command/dispatch
lease and ack methods. The E2E driver observes their HTTP effects; it does not
call their private SQL or mutate their tables.

### 3.3 Conductor and Performer surfaces

- `ConductorService` inherits `ConductorPodiumSyncMixin`.
  `ConductorPodiumSyncMixin.coordinate_background_once()` runs the workflow
  tick; `ConductorPodiumSyncMixin.handle_podium_command()` applies
  `project.configure` and other control commands;
  `ConductorPodiumSyncMixin.poll_podium_dispatch_once()` leases and dispatches
  work; `ConductorPodiumSyncMixin.build_podium_report()` produces the
  sanitized runtime report. The external Conductor API server invokes these
  methods from its polling loop.
- `WorkflowDriver.drive_once()` advances one durable run. Its existing flow is
  `_plan()`, `_execute_task()`, `start_gate()`, command execution through
  `AcceptanceGate.run_commands()`, gate evaluation through
  `AcceptanceGate.evaluate()`, and projection through `_project_task_state()`.
- `ConductorStore` is the durable state owner. The approved transition methods
  for probes are `create_run()`, `start_plan()`, `record_plan()`, `start_task()`,
  `record_execute()`, `start_gate()`, `record_gate()`,
  `record_runtime_wait()`, `resume_runtime_wait()`, `get_run()`,
  `get_task()`, `list_tasks()`, and `get_gate_evidence_summary()`.
  Direct store calls are allowed only in the isolated Conductor test process
  for duplicate/stale probes; they are not a substitute for Linear projection.
- `performer.cli.run_turn()` is the one-shot request/result entrypoint.
  `performer.backend.TurnBackend.plan()`, `.execute()`, and `.gate()` are the
  three turn contracts. `performer.codex_client.CodexSdkClient.run_session()`
  is the real SDK call. `runtime_wait_from_events()` is the only runtime-wait
  classifier.
- `conductor.runtime.PerformerRuntime.prepare_environment()`, `.write_request()`,
  `.run()`, and `.accept_result()` own isolated home materialization and result
  fencing. Do not launch `codex` directly from the E2E driver.

## 4. Phase OAuth

### Objective

Prove the existing Podium account/session and Linear OAuth installation are
usable without starting a new OAuth flow.

The authenticated checks use the existing signed-in browser session through
the browser skill. Open `SYMPHONY_E2E_PODIUM_URL` in a clean
browser context for the unauthenticated probe, then use the already signed-in
browser context for the authenticated probes. The runner may inspect same-origin
HTTP responses through the browser observation file described above, but must
not export, read, or copy the httpOnly session cookie. If the existing signed-in context is unavailable,
record `oauth_browser_session_unavailable` and fail this phase; do not fall
back to a login form or a newly created account.

### Ordered checks

1. Call `GET /api/v1/auth/me` without a session and require `401 unauthorized`.
2. Reuse the already authenticated browser/API session and call the same route;
   require `200` and only the public user id/email fields.
3. Call `GET /api/v1/linear/installations`; require one active installation or
   record the exact installation state and fail with
   `linear_reauthorization_required`. Save its public `id`, organization id,
   workspace id, and `app_user_id` as the batch's installation identity.
4. Verify the public installation response contains identity and health fields
   but no access token, refresh token, cookie, or client secret.
5. Call `GET /api/v1/linear/projects`; require the configured project slug to
   be present and record its id/team id.
6. Run negative callback probes only against the existing Podium service:
   missing state and a random invalid state must fail. An expired-state check
   belongs to the local callback test because creating an expired state would
   require starting OAuth. Do not call
   `POST /api/v1/linear/installations/oauth`, do not visit the consent URL, and
   do not persist a candidate installation.

### Existing regression tests to run

Run these selectors before the real checks; they are regression evidence, not
substitutes for the real browser/API checks:

```text
tests/test_podium_runtime_polling.py::test_runtime_report_keeps_only_a_bound_sanitized_managed_run_view
tests/test_podium_runtime_polling.py::test_runtime_report_rejects_a_stale_managed_run_binding
tests/test_podium_runtime_polling.py::test_runtime_report_redacts_escaped_and_prefixed_secret_fields
tests/test_podium_storage.py::test_runtime_profile_summary_exposes_hashes_but_not_documents_or_local_refs
tests/test_real_flow_fixture.py::test_linear_fixture_uses_bearer_for_podium_app_token
```

### OAuth pass rubric: 4/4

- `1/1`: unauthenticated and authenticated session behavior is observed.
- `1/1`: active installation identity, selected project, app user, and health
  are observed without a new authorization.
- `1/1`: negative callback behavior fails closed and no candidate installation
  is created.
- `1/1`: response, browser, Podium log, and report scans find no credential
  value or raw auth file content; all failures are categorized and actionable.

Any missing active installation is `0/4` for this phase, even if the callback
URL itself is reachable. The correct next action is external reauthorization,
not an agent-generated consent flow.

## 5. Phase Linear

### Objective

Prove direct Linear fixture access independently of Podium, OAuth, Conductor,
and Performer. Podium polling, checkpoint, binding, dispatch, and lease/ack
belong exclusively to Overall, where the complete managed product path is
tested.

### Ordered checks and allowed calls

1. Construct `LinearFixture.from_environment(timeout=...)` with
   `LINEAR_API_KEY` removed from the process environment. Call
   `fixture.graphql("query { viewer { id } }")`. A `401` is an immediate
   `linear_fixture_failed` failure; do not retry indefinitely.
2. Call `fixture.project(project_slug)` and record only project id, team id,
   name, and slug. This is the only approved project lookup.
3. Resolve the selected team's workflow states with
   `fixture.workflow_states(project["team"]["id"])`. Select exactly one
   non-terminal state whose `type` is `backlog` (fall back to `unstarted` only
   when the team has no backlog state); multiple or missing candidates fail
   with `linear_fixture_state_ambiguous`.
4. Create one disposable, non-delegated parent with
   `fixture.create_parent_issue(team_id, project_id, state_id, title,
   description, delegate_id=app_user_id)`. The helper uses the same
   `issueCreate` input contract as `ManagedRunLinearProxy`, sets
   `parentId: null`, and verifies the explicit returned `parent` field is null.
   Record its id and identifier.
5. Read it with `fixture.issue()` and require `parent` to be null. Read its
   children with `fixture.children()` and require explicit `parent.id` and
   `parent.identifier` on every child.
6. Record only direct Linear identifiers and sanitized GraphQL failures. This
   phase must not instantiate `_PodiumObserver`, read a browser observation,
   require an OAuth installation, inspect a runtime, or observe a dispatch.

### Existing regression tests to run

```text
tests/test_podium_runtime_polling.py::test_active_blocker_ids_exclude_terminal_and_unrelated_relations
tests/test_podium_runtime_polling.py::test_blocked_dispatch_is_rechecked_after_its_blocker_clears
tests/test_podium_runtime_polling.py::test_dispatch_lease_requeues_when_a_later_blocker_page_is_active
tests/test_podium_runtime_polling.py::test_reconciliation_refreshes_blocked_dispatches_after_a_completed_scan
tests/test_podium_runtime_polling.py::test_proxy_authorizes_the_runtime_owning_its_ready_binding_without_a_group_table
tests/test_conductor_podium_sync.py::test_podium_tick_applies_command_before_reporting_dispatch_and_workflow
tests/test_conductor_podium_sync.py::test_smoke_check_accepts_and_matches_the_podium_project_label
tests/test_real_flow_fixture.py::test_linear_fixture_normalizes_current_project_teams_shape
tests/test_real_flow_fixture.py::test_linear_fixture_reports_http_status_without_credentials
tests/test_real_flow_fixture.py::test_linear_fixture_lists_team_workflow_states
tests/test_real_flow_fixture.py::test_linear_fixture_creates_a_parent_issue_with_explicit_parent_null
```

### Linear pass rubric: 4/4

- `1/1`: the `.env` token successfully reads viewer and project data, with no
  token value in evidence. A `401` is a hard failure.
- `1/1`: project and workflow-state identity are resolved directly.
- `1/1`: one root fixture issue is created and read with explicit parent
  semantics.
- `1/1`: all direct Linear failures are bounded and sanitized, with no Podium,
  OAuth, runtime, or dispatch dependency.

No Linear phase pass may be claimed from a mocked GraphQL transport or a local
database-only assertion.

## 6. Phase Performer

### Objective

Prove a real `performer` process can consume only the static test config and
official opaque Codex login seed, run the three turn kinds with `gpt-5.4`, and
preserve fenced, structured, sanitized results without Podium, OAuth, or
Linear.

### Ordered checks and allowed calls

1. Materialize a fresh phase `CODEX_HOME` through
   `PerformerRuntime.prepare_environment()` from the approved seed. Assert the
   directory contains only the approved seed files plus the managed config;
   assert the path is not `~/.codex`.
2. Parse the test seed's `config.toml` using the same shared validation
   contract in `performer_api.codex_runtime`; require `gpt-5.4` and file auth,
   and record its hash. Do not read or merge a Podium Performer profile.
3. Create a disposable git workspace and write a plan turn request through
   `PerformerRuntime.write_request()`. Launch only
   `performer.cli.run_turn()`/the installed `performer` executable; do not
   call `codex app-server` directly.
4. Require `performer.backend.TurnBackend.plan()` to return a valid `Plan`, no
   workspace changes, and the exact `TurnContext`.
5. Use the returned task to run `TurnBackend.execute()`. Require changed files
   to remain within `files_likely_touched`, and require a valid
   `ExecuteResult`.
6. Run `TurnBackend.gate()` with bounded command evidence. Require a valid
   `GateResult`, no workspace changes, and a read-only turn.
7. Read the result JSON through `PerformerRuntime.accept_result()` and verify
   the attempt id, fencing token, run id, task id, and turn kind are exact.
8. Capture SDK events and performer stdout/stderr. Classify waits with
   `runtime_wait_from_events()` and terminal upstream errors with
   `CodexSdkClient`'s existing stream/error path. A provider `502` must remain
   an upstream failure with its HTTP category, not `invalid_structured_output`.
9. Scan every event, result, log, and report for token-shaped values, auth
   contents, Authorization headers, and unbounded raw provider output.

### Existing regression tests to run

```text
tests/test_performer_sdk_client.py::test_sdk_client_reads_schema_json_and_notification_payload
tests/test_performer_sdk_client.py::test_sdk_client_surfaces_terminal_upstream_error_after_stream_retries
tests/test_conductor_runtime.py::test_runtime_prepares_an_isolated_home_from_approved_seed_files
tests/test_conductor_runtime.py::test_runtime_materializes_managed_profile_config_and_selected_credential_slot
tests/test_conductor_runtime.py::test_runtime_fails_closed_when_selected_credential_slot_is_missing
tests/test_conductor_runtime.py::test_runtime_provisions_selected_slot_only_from_explicit_staged_seed
tests/test_conductor_runtime.py::test_runtime_sanitizes_performer_stdout_and_stderr_before_persisting
tests/test_conductor_runtime.py::test_runtime_preserves_sanitized_performer_failure_reason
tests/test_performer_api_codex_runtime.py::test_runtime_config_normalizes_hashes_and_hides_content_from_summary
tests/test_performer_api_codex_runtime.py::test_performer_profile_config_carries_only_current_non_secret_profiles
```

### Performer pass rubric: 4/4

- `1/1`: isolated profile/home is materialized from the fixed seed, with the
  exact `gpt-5.4` configuration and no secret crossing the Podium boundary.
- `1/1`: real plan, execute, and gate turns produce valid structured results
  with exact context and fencing fields.
- `1/1`: SDK retries, runtime waits, process failures, and provider errors are
  captured with stable error codes and correlated logs.
- `1/1`: result, event, stdout/stderr, and report scans prove no secret or
  raw credential path is exposed.

If the provider is unavailable, this phase is `failed`, not `passed with a
synthetic result`. A synthetic SDK fake is allowed only in the listed local
pytest regression tests.

## 7. Overall MVP Phase

### Preconditions

The runner must verify `oauth.status == passed`, `linear.status == passed`, and
`performer.status == passed` for the same `run_id`, profile hash, project id,
and staged-seed hash. Otherwise Overall writes `status=skipped` and
`blocked_by` without mutating Linear.

The runner observes the already enrolled Conductor at
`SYMPHONY_E2E_CONDUCTOR_URL`; it does not enroll a replacement process or
transport a runtime/proxy bearer. The Conductor must already be bound to the
selected disposable repository, and the runner fails the repository
materialization check when that explicit binding is absent.

### Deterministic Overall fixtures

Overall prepares exact verifier fixtures under the run artifact root. Before
creating a delegated parent, the runner must also receive
`SYMPHONY_E2E_FIXTURE_REPOSITORY`, an existing disposable Git workspace bound
to the enrolled Conductor. The scripts are copied into that workspace only
when the target is explicitly configured; no repository path is inferred from
the project or Linear label. Missing or conflicting materialization is a
binding failure and prevents scenario issue creation.
Disposable parent issues are retained with an explicit
`cleanup=retained_for_audit` observation so their Linear tree and logs remain
inspectable; the runner never silently assumes cleanup after a timeout.

| Fixture | Required verification command | Deterministic behavior |
|---|---|---|
| `success` | `python .e2e/verify_success.py` | exits `0` every time |
| `rework` | `python .e2e/verify_once.py` | exits `1` on the first invocation and `0` on the next; its counter is in an ignored `.e2e/state` file |
| `block` | `python .e2e/verify_always_fail.py` | exits `1` on every invocation |

The runner writes these exact fixture scripts before cloning the workspace:

```python
# .e2e/verify_success.py
raise SystemExit(0)

# .e2e/verify_once.py
from pathlib import Path
counter = Path(".e2e/state/verify-count")
counter.parent.mkdir(parents=True, exist_ok=True)
count = int(counter.read_text() or "0") if counter.exists() else 0
counter.write_text(str(count + 1))
raise SystemExit(1 if count == 0 else 0)

# .e2e/verify_always_fail.py
raise SystemExit(1)

# .e2e/ask_for_input.py
from pathlib import Path
if not Path(".e2e/input-approved").exists():
    input("SYMPHONY_REAL_E2E_INPUT:")
print("input-approved")
```

The fixture scripts are read-only to the Codex Gate. The execute task may add
only the declared result file; it may not modify `.e2e/`. The parent issue
description must require exactly the command in the table and the corresponding
file scope. After the plan turn, the runner validates the committed plan
payload and fails with `fixture_plan_contract_mismatch` if the command or file
scope differs; it does not reinterpret a model-generated plan to make a test
pass.

The `rework` and `block` assertions therefore use the real
`AcceptanceGate.run_commands()` and `AcceptanceGate.evaluate()` paths. The
first `rework` command failure must leave `rework_count=1` and task state
`in_progress`; the next command pass must reach `done`. The `block` command
must fail twice and leave task and parent `blocked` with
`latest_reason=gate_failed`.

The runtime-wait fixture is separate from the fixed `approval_policy=never`
success profile. Its disposable task runs
`python .e2e/ask_for_input.py`, which requests terminal input when the ignored
marker `.e2e/input-approved` is absent. The real Codex SDK must emit a terminal
interaction event, and `runtime_wait_from_events()` must classify it as
`tool_input_required`. The runner then records the wait, verifies the
`[Human Action]` child, creates the marker as the documented human action,
reopens that child, and verifies `_runtime_wait_reopened()` starts a fresh
fenced attempt. If the provider does not emit the event, the scenario fails
with `runtime_wait_stimulus_unavailable`; it is never replaced by a fake SDK
event in the real batch.

### Ordered product flow

1. Verify the already enrolled Conductor binding and its profile generation/hash
   through the authenticated runtime observation and local Conductor API. The
   runner never mutates `memberIds`, starts OAuth, or supplies a bearer.
2. Create a fresh delegated parent issue after binding is ready. Do not move it
   manually to `In Review` or `Done`.
3. Let Podium polling and `poll_podium_dispatch_once()` create and lease one
   dispatch. Let `WorkflowDriver.drive_once()` perform plan, task projection,
   execute, command verification, gate, and parent projection.
4. Verify success through all three product surfaces: Conductor `workflow.db`,
   `GET /api/v1/managed-runs`, and Linear issue/child tree plus comments.
5. Run separate disposable issues/workspaces for rework and block. The first
   gate failure must be produced by the real `AcceptanceGate.evaluate()` path;
   the second failure must be produced by the same path, not by manually
   editing the store state.
6. For duplicate-result probes, archive the exact accepted result JSON before
   applying it. Replay the same result through the Conductor-owned
   `record_execute()`/`record_gate()` state transition boundary in the isolated
   Conductor store probe; do not call the private
   `_result_attempt_is_duplicate()` helper. Assert no second state transition,
   comment, child issue, or parent transition. The report marks this as an
   isolated fencing probe, distinct from the external Codex success turn.
7. Submit an old attempt/fencing token and an old plan-version gate result to
   the same Conductor transition boundary. Assert `StaleAttemptError` or
   `StaleRuntimeResult`, unchanged current task/run, warning log, and no Linear
   mutation. The archived stale payload and the before/after managed-run views
   are required evidence.
8. Exercise the runtime-wait fixture above through the real Performer event
   classifier and `WorkflowDriver._record_wait()` product path. Resolve it only
   by reopening the recorded Linear wait issue and observing
   `_runtime_wait_reopened()`; a comment alone must not resume it.
9. Collect and scan Podium managed-runs, Linear comments, Conductor logs,
    Performer logs, request/result files, and the final report for redaction
    and durable error parity.

### Existing regression tests to run

```text
tests/test_workflow_driver.py::test_workflow_driver_creates_subissues_and_runs_sequential_gate
tests/test_workflow_driver.py::test_workflow_driver_closes_parent_after_every_subissue_passes
tests/test_workflow_driver.py::test_workflow_driver_logs_the_second_gate_failure
tests/test_workflow_driver.py::test_workflow_driver_ignores_stale_result_without_failing_run
tests/test_workflow_driver.py::test_workflow_driver_projects_runtime_wait_as_human_action_child
tests/test_workflow_driver.py::test_workflow_driver_does_not_duplicate_existing_subissues
tests/test_conductor_workflow.py::test_gate_failure_allows_one_rework_then_blocks_task_and_parent
tests/test_conductor_workflow.py::test_duplicate_gate_result_is_idempotent
tests/test_conductor_workflow.py::test_duplicate_plan_result_is_idempotent
tests/test_conductor_workflow.py::test_stale_attempt_result_cannot_change_the_current_task
tests/test_conductor_workflow.py::test_stale_plan_revision_gate_result_cannot_advance_task
tests/test_conductor_workflow.py::test_runtime_wait_is_durable_and_can_resume_once_reopened
tests/test_conductor_workflow.py::test_failure_reason_is_sanitized_before_persistence
tests/test_conductor_gate.py::test_gate_requires_commands_and_single_codex_gate
tests/test_conductor_gate.py::test_gate_preserves_score_rubric_and_artifact_provenance
tests/test_conductor_podium_sync.py::test_podium_report_projects_the_managed_run_shape_consumed_by_web
tests/test_conductor_podium_sync.py::test_managed_run_snapshot_redacts_bare_token_shapes
```

### Overall pass rubric: 4/4

- `1/1`: one real parent reaches Done only after every real child reaches Done
  through the sequential plan/execute/command/Codex Gate path.
- `1/1`: real Gate behavior proves first failure rework and second failure
  block, with exact task/parent states, comments, evidence, and logs.
- `1/1`: duplicate and stale results are rejected/idempotent with no state or
  Linear projection regression.
- `1/1`: runtime waits, failures, logs, managed-runs response, and Linear
  projection are sanitized, correlated, and visibly actionable.

The overall MVP is not accepted if any one scenario is replaced by a mock,
manual Linear state transition, direct database state edit, or an inferred
success from a process exit code.

## 8. Failure Collection and Repair Cadence

This is the required agent loop after this design is implemented. The word
"batch" below always means one real E2E invocation containing OAuth, Linear,
and Performer, not one phase selected in isolation:

1. Make one bounded phase change only.
2. Run the exact focused pytest selectors for the affected module(s).
3. Run one complete `make test` and save the entire output, including all
   failures; do not stop after the first error.
4. Run **one complete real E2E batch**. It must execute OAuth, Linear, and
   Performer, collect all three reports/logs/evidence bundles, and then either
   run Overall or write its concrete `blocked_by` result. Do not invoke a
   phase-only run as a substitute.
5. Group the complete failure set from `make test` **and all three real phases**
   by root cause (`auth`, `linear`, `provider`, `binding`,
   `workflow`, `fence`, `redaction`, or `evidence`).
6. Fix one root-cause group as a coherent change, add the regression guard,
   then repeat the full `make test` and the **complete three-phase real E2E
   batch**. Do not rerun only the phase where the first symptom appeared.
7. Do not patch one assertion at a time, suppress a failure, add a retry with
   no visible counter, or proceed to Overall with a failed prerequisite.

The batch is the unit of evidence and the unit of diagnosis. A phase-only run
can be used after the batch to shorten local investigation, but its result must
never be reported as a new acceptance attempt; the next acceptance attempt is
always a fresh three-phase batch followed by Overall when eligible.

The agent must update the phase report after every attempt. A report with a
failure count but no linked service logs, durable state, and exact next action
is incomplete evidence.

## 9. Final Acceptance Rubric

The final run is accepted only when all of the following are true:

| Requirement | Required evidence | Score |
|---|---|---:|
| OAuth reuse | Existing session/install, no reauth, no secret response | 0-4 |
| Linear access/routing | `.env` token read/write, project, binding, polling, epoch, one dispatch | 0-4 |
| Performer | Real `gpt-5.4` plan/execute/gate, staged OAuth home, result and logs | 0-4 |
| Successful closure | Linear parent/children, workflow DB, managed-runs, logs | 0-4 |
| Gate rework/block | First failure rework, second failure block, visible reasons | 0-4 |
| Duplicate/stale safety | Replay and stale fence leave current state unchanged | 0-4 |
| Runtime redaction | Wait/failure/log/API/Linear scans contain no secrets | 0-4 |

`4/4` requires real evidence for the row. Unit tests alone cap a Linear,
Conductor, Performer, or Codex-dependent row at `2/4`. Any known `401`, `502`,
missing artifact, hidden error, or unresolved stale state makes the relevant
row `0/4` or `1/4`, never a pass.

## 10. Current Known Blockers

The document intentionally records current environment blockers instead of
designing around them:

- The current `.env` `PODIUM_LINEAR_APP_ACCESS_TOKEN` probe returns
  `linear_request_failed:http_401` from the official Linear GraphQL endpoint.
- The current remote Codex provider accepts initialization but returns
  `502 Bad Gateway` on `/v1/responses` for the fixed `gpt-5.4` probe.
- A prior Podium installation was observed in
  `reauthorization_required`; the OAuth phase must verify the current running
  installation and may report this blocker, but must not reauthorize itself.

These blockers are expected to be fixed outside the design document or in a
separate approved implementation slice. They do not justify weakening any
phase gate.
