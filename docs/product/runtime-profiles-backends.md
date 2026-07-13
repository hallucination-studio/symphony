# Runtime profiles and Codex control

Status: **proposed for user approval, 2026-07-13**.

This is the implementation contract for
[ADR-0005](../decisions/0005-conductor-owned-opaque-codex-credentials.md).
It is intentionally limited to the MVP.

## 1. Target

```text
Podium
  -> temporary authenticated request
Conductor
  -> one Codex context
Codex SDK / app-server
  -> login, config, manual check, turn
Performer
  -> fenced result
```

Podium stores Symphony run policy, but no Codex config, account, credential,
path, or check result.

## 2. Product model

### Runtime profile

A `runtime_profile` contains only Symphony run policy:

```json
{
  "version": 1,
  "model": "gpt-5.4",
  "model_provider": "openai",
  "approval_mode": "auto_review",
  "reasoning_effort": "high",
  "reasoning_summary": "auto",
  "sandbox": {
    "plan": "read_only",
    "execute": "workspace_write",
    "gate": "read_only"
  },
  "initialize_timeout_ms": 5000,
  "turn_timeout_ms": 3600000,
  "initialize_max_attempts": 4,
  "overload_max_attempts": 5
}
```

`gpt-5.4` is required by real E2E, not hard-coded as the production default.

### Performer profile

A `performer_profile` selects:

- `performer_kind = codex`;
- one `runtime_profile`;
- bounded workflow policy.

A `performer_binding` selects one Performer profile for one project binding.
There are no profile revision tables and no `performer_credentials` table.

### Codex context

One Conductor starts with:

```text
optional CODEX_HOME=/path/chosen-by-the-operator
optional codex_bin=/absolute/path/to/codex
```

Codex owns every file and credential in that context. Symphony does not list,
copy, parse, hash, repair, or reconcile them. If `CODEX_HOME` is unset, Codex
uses its official default. The environment is fixed for the Conductor lifetime,
so the operator may reuse an existing official Codex login without importing
it into Symphony.

One Conductor has one active Codex account. Switching account means logout and
login again. Replacing an API key uses Codex's SDK login operation; the key is
not a runtime-profile or TOML field owned by Symphony.

The Codex context is not usable for managed turns until the user runs a manual
real-turn Check. A Conductor restart and every login/config mutation invalidate
the previous Check result.

## 3. Durable command

`project.configure` carries only Symphony data:

```json
{
  "type": "project.configure",
  "binding_id": "...",
  "binding_config_version": 7,
  "performer_profile_id": "...",
  "runtime_profile_id": "...",
  "execution_policy": {},
  "execution_policy_sha256": "...",
  "turn_policy": {},
  "turn_policy_sha256": "...",
  "linear_project_id": "...",
  "repository": {"mode": "local_path", "value": "..."}
}
```

Reject Codex-owned fields such as:

```text
config_document
config_sha256
credential_id
credential_ref
slot_id
api_host
codex_home
codex_endpoint
```

Codex config changes do not change the binding generation.

## 4. Conductor ownership

Add one focused module:

```text
packages/conductor/src/conductor/codex.py
```

It contains one `CodexController` with:

- the fixed Conductor process environment;
- one `asyncio.Lock`;
- one optional device-login handle;
- public SDK account/login/logout methods;
- a manual real-turn Check method;
- the SDK's typed app-server client, limited to
  `config/read`, `config/value/write`, and `fs/readFile`;
- one serialized Check state backed by a secret-free local store row.

Do not create a generic app-server client or multiple manager/service layers.
Do not write `config.toml` through Python filesystem APIs.

Integration:

- `ConductorService` owns one `CodexController`;
- `ConductorApiServer._poll_live_once()` calls its closed actions;
- `WorkflowDriver._run_turn()` holds the same lock until Performer exits;
- `PerformerRuntime.prepare_environment()` passes an allowlisted environment
  instead of copying files: `HOME`, optional `CODEX_HOME`, `PATH`/locale/temp
  basics, optional `codex_bin`, and Symphony run-policy values only;
- `PerformerRuntime.run()` drops the `codex_home` argument but keeps process,
  log, timeout, result, and fencing behavior;
- remove `PerformerCredentialSlots` and its CLI after callers reach zero.

Conductor still launches Performer as a command and never imports it.

## 5. Podium API

Reuse `LiveConductorRelay`. Do not add a second relay or use durable
`runtime_commands` for Codex control.

These browser routes and live operations are the closed MVP contract:

| Browser route | Live operation | Purpose |
|---|---|---|
| `GET /api/v1/conductors/{id}/performer-codex` | `performer_codex.status` | live account, pending-login, and Check status |
| `POST /api/v1/conductors/{id}/performer-codex/login` | `performer_codex.login` | device-code or API-key login |
| `DELETE /api/v1/conductors/{id}/performer-codex/login` | `performer_codex.session.delete` | cancel pending login or logout |
| `GET /api/v1/conductors/{id}/performer-codex/config` | `performer_codex.config.read` | source-format config view |
| `PATCH /api/v1/conductors/{id}/performer-codex/config` | `performer_codex.config.write` | change `openai_base_url` |
| `POST /api/v1/conductors/{id}/performer-codex/check` | `performer_codex.check` | manually run a real execution Check |

Every route requires:

- authenticated user;
- ownership of the Conductor;
- online Conductor;
- bounded request/reply;
- `Cache-Control: no-store`;
- no request/response body logging.

Request bodies are closed contracts: reject unknown fields rather than
forwarding them to Codex. `openai_base_url` must be a bounded absolute HTTP(S)
URL without user-info, query, or fragment; loopback HTTP remains valid for
local testing. SDK/app-server responses are untrusted input and must pass the
operation-specific normalizer before they affect state or reach the browser.

Podium persists none of these payloads or results.

Extend `LiveConductorRelay` with closed normalizers for exactly those six
operations. Do not pass arbitrary Conductor JSON through to the browser. Keep
the existing one-minute Check rate limit, duplicate in-flight rejection, lease
fencing, deadline, stale-reply rejection, and `Cache-Control: no-store` rules.
Remove the legacy `performer_credentials.*` operations only after their routes,
callers, and tests have migrated.

Authentication, authorization, validation, conflict, rate-limit, timeout, and
relay failures use Podium's existing HTTP error envelope:

```json
{"error": {"code": "closed_set_code", "message": "sanitized stable summary"}}
```

A control operation that reached Conductor returns a closed normalized result.
Its failure form is:

```json
{
  "status": "failed",
  "error_code": "closed_set_code",
  "sanitized_reason": "actionable text without secrets",
  "action_required": "next_operator_action",
  "retryable": false,
  "next_action": "retry_or_change_configuration"
}
```

SDK/app-server response bodies, file paths, exception representations, and
credentials never pass through either envelope. A completed Check returns HTTP
200 with `check_status=ready` or `check_status=failed`. The operation result is
never substituted for an HTTP boundary error.

Conductor stores only this local row in `workflow.db`:

```text
codex_control_state
  id                 always 1
  check_status       unchecked | checking | ready | failed
  last_check_outcome none | passed | failed
  last_checked_at    nullable UTC timestamp
  last_error_code    sanitized closed-set code or empty
  last_sanitized_reason
                     bounded sanitized text or empty
  updated_at         UTC timestamp
```

No account identity, auth method, API host, config source/path, API key, OAuth
data, or SDK response body is stored. On startup Conductor sets
`check_status=unchecked` while retaining `last_check_outcome` and the previous
sanitized result for operator evidence. Podium only obtains the current
projection through the live relay.

`GET .../performer-codex` returns only this normalized projection:

```json
{
  "version": 1,
  "conductor_id": "conductor-id",
  "observed_at": "2026-07-13T00:00:00Z",
  "account": {
    "status": "authenticated",
    "auth_method": "chatgpt",
    "display_label": "user@example.com"
  },
  "login": {"status": "idle"},
  "check": {
    "status": "unchecked",
    "last_check_outcome": "passed",
    "last_checked_at": "2026-07-13T00:00:00Z",
    "error_code": null,
    "sanitized_reason": null
  }
}
```

`account.status` is `authenticated` or `logged_out`; `auth_method` is
`chatgpt`, `api_key`, `other`, or `none`. `display_label` is a bounded
SDK-derived account label or `null`, never a token or raw account object.
`login.status` is `idle`, `pending`, `succeeded`, `failed`, or `lost`; the
device URL and user code appear only while pending. All third-party SDK fields
are validated and normalized before this response is built.

## 6. Login

### Device code

`POST .../login` with:

```json
{"method": "device_code"}
```

Conductor calls `AsyncCodex.login_chatgpt_device_code()` and returns:

```json
{
  "status": "pending",
  "check_status": "unchecked",
  "verification_url": "https://auth.openai.com/codex/device",
  "user_code": "ABCD-1234"
}
```

The handle stays in Conductor memory. `GET .../performer-codex` reports
`pending`, `succeeded`, `failed`, or `lost`. Restart changes a pending login to
`lost`. While pending, the controller blocks config/check/turn actions, but the
read-only status request remains available.

`DELETE .../login` cancels a pending handle.

Conductor sets `check_status=unchecked` before starting device login and keeps
it non-ready whether login succeeds, fails, is cancelled, or is lost after a
restart. It does not start Check automatically.

### API key

`POST .../login` with:

```json
{"method": "api_key", "api_key": "<secret>"}
```

Conductor calls `AsyncCodex.login_api_key(api_key)`. The response contains only
success/failure. The key is never echoed, logged, persisted, or retried.

This is the official OpenAI API-key login. Custom-provider credentials remain
operator-managed outside Podium.

Calling this endpoint again replaces the current API-key login through Codex.
Conductor invalidates the previous Check state before calling the SDK and
leaves it `unchecked` on success. API-key replacement does not write a key into
`config.toml` and does not trigger Check automatically.

Success returns only:

```json
{"status": "succeeded", "check_status": "unchecked"}
```

### Logout

If there is no pending login, `DELETE .../login` calls
`AsyncCodex.logout()`. Account switching is an explicit logout followed by a
new login. Logout invalidates Check readiness; there is no saved prior account
to restore if the next login or Check fails.

Successful cancellation or logout returns:

```json
{"status": "succeeded", "check_status": "unchecked"}
```

## 7. API host and config source

### Update host

`PATCH .../config` accepts only:

```json
{
  "expected_version": "opaque-codex-version",
  "openai_base_url": "https://api.example.test/v1"
}
```

Conductor calls `AsyncCodexClient.request()` with the SDK-generated
`ConfigValueWriteParams` and `ConfigWriteResponse` contracts for
`config/value/write`:

```text
keyPath = openai_base_url
value = request.openai_base_url
mergeStrategy = upsert
expectedVersion = request.expected_version
```

The browser cannot provide `filePath` or another key. Codex validates and
writes its own `config.toml`. Symphony never calls `Path.write_text()`,
`open(..., "w")`, or app-server `fs/writeFile` for Codex config.

A stale version returns HTTP 409 / `codex_config_conflict`.

Conductor sets `check_status=unchecked` before attempting the write. Success,
failure, or a possibly partial SDK-side write never starts Check and never
restores the previous Base URL. The user must run Check explicitly.

Success returns the SDK's new opaque version but never its file path:

```json
{
  "status": "updated",
  "config_version": "new-opaque-codex-version",
  "check_status": "unchecked"
}
```

### Display config

`GET .../config`:

1. calls `config/read(includeLayers=true)`;
2. uses the user layer and version returned by Codex;
3. calls `fs/readFile` for that returned path;
4. validates `dataBase64`, decodes at most 64 KiB as UTF-8, and rejects invalid
   encoding or oversized content;
5. applies secret redaction and returns no path or raw SDK field.

Response:

```json
{
  "exists": true,
  "config_version": "opaque-codex-version",
  "source": "model = \"gpt-5.4\"\n"
}
```

The source:

- is UTF-8 and at most 64 KiB;
- keeps TOML structure, comments, and order;
- passes through normal secret redaction;
- is never persisted, cached, reported, or logged.

Podium does not show a normalized config table. Advanced config remains managed
with normal Codex tooling outside Symphony.

## 8. Performer SDK mapping

Continue through:

- `performer.cli.run_turn()`;
- `performer.codex_client.CodexSdkClient`;
- `performer.codex_config.CodexConfig`.

The SDK launcher receives only optional `codex_bin` and allowlisted
`HOME`/`CODEX_HOME`. It receives no API host, API key, auth mode, config
source, or forced file credential-store setting.

If `CODEX_HOME` is unset, Performer must still receive `HOME` so Codex can use
its official default. Podium/Linear runtime tokens and all other parent secrets
remain excluded from the subprocess environment.

### Thread

```python
thread = await codex.thread_start(
    cwd=str(workspace),
    model=policy.model,
    model_provider=policy.model_provider,
    sandbox=turn_sandbox,
    approval_mode=policy.approval_mode,
    ephemeral=True,
)
```

### Turn

```python
turn = await thread.turn(
    prompt,
    effort=policy.reasoning_effort,
    summary=policy.reasoning_summary,
    sandbox=turn_sandbox,
    approval_mode=policy.approval_mode,
    output_schema=output_schema,
)
```

Use pinned SDK enums in production.

## SDK capability boundary

The pinned top-level `AsyncCodex` API supports login/account/logout and
thread/turn calls. It does not currently expose a config-write convenience
method. Persistent Base URL changes therefore use the same SDK package's typed
`AsyncCodexClient.request()` transport plus generated config request/response
models. Direct file editing and private `AsyncCodex._client` access are never
allowed fallbacks.

| Turn | Sandbox | Writes |
|---|---|---|
| plan | read-only | none |
| execute | workspace-write | declared task scope |
| gate | read-only | none |

All existing timeout, retry, wait, error, stale-result, duplicate-result,
Gate-rework/block, logging, and Linear behavior remains.

## 9. Check

Check is manual. Login completion, API-key replacement, logout, and config
changes only invalidate readiness; none of them invokes this endpoint.

Conductor serializes this non-secret state through its local
`codex_control_state` row:

```text
unchecked -> checking -> ready
                      -> failed
```

It starts as `unchecked` after every Conductor start. It changes to `unchecked`
before any login, logout, or config mutation. Podium returns the live state but
does not persist it.

`POST .../check` has no model/provider or credential payload. It uses the
Conductor's current bound runtime profile and opens a fresh SDK session in the
same fixed Codex process environment used for managed turns.

A pass requires:

1. SDK/app-server initialization;
2. one ephemeral read-only thread;
3. one bounded structured turn.

No current runtime profile returns `codex_runtime_policy_required`.
Initialization or account status alone cannot pass.

The normalized success response is:

```json
{
  "check_status": "ready",
  "last_check_outcome": "passed",
  "checked_at": "2026-07-13T00:00:00Z",
  "error_code": null,
  "sanitized_reason": null
}
```

An executed but unsuccessful Check uses the same shape with
`check_status=failed`, `last_check_outcome=failed`, and bounded non-secret
`error_code` / `sanitized_reason` values.

Only `ready` allows a new plan, execute, or gate turn. `unchecked` returns
`codex_check_required`; `failed` returns `codex_check_failed` with the latest
sanitized reason. A logged-out account may return the more specific
`codex_login_required`.

If a managed run reaches this gate, reuse the existing backend-setup failure
path: persist the sanitized reason in run/work-item state, emit the structured
failure log, expose it in the managed-runs view, and project the actionable
state to Linear. Do not silently skip or acknowledge the dispatch as success.

A failed Check does not roll back Base URL, API key, or account changes. It
leaves the current Codex context non-ready. The user modifies the context or
logs in again and manually reruns Check. Symphony cannot restore old
credentials because it never stores them.

The UI may apply a Base URL change and an API-key replacement in either order,
then run one Check after the final mutation. Because all actions share one lock
and readiness becomes `unchecked` before the first mutation, no Check
generation or revision table is needed and no managed turn can run between
configuration and Check.

## 10. Shared contracts and removals

Update `performer_api.codex_runtime` to contain only Symphony policy/profile
contracts.

Remove:

- `validate_codex_toml()` and Codex key allowlists;
- config format/document/hash fields;
- credential/slot fields;
- production Codex-home copying;
- `auth.json` copy-back;
- slot inventory/select/check APIs and CLI.

Keep:

- policy hash validation;
- binding generation fencing;
- request/result fencing;
- sanitized error and log contracts.

## 11. Security

- Podium never stores Codex config/account/credential/check data.
- The latest sanitized Check state exists only in Conductor `workflow.db` and
  resets to `unchecked` on restart; Podium never stores it.
- The API key exists only in the live request path.
- `auth.json` and keyring contents are never read.
- Performer receives only the environment allowlist above, never Podium or
  Linear credentials inherited from Conductor.
- The browser cannot choose a file path or config key.
- Config source uses normal redaction.
- Config/login/check and managed turns share one lock.
- Check start, completion, and failure use structured logs with
  `conductor_id`, `check_status`, `error_code`, `sanitized_reason`,
  `action_required`, `retryable`, and `next_action`; no SDK response body or
  credential value is logged.
- Config may enable executable Codex features, so only the authenticated owner
  of the bound Conductor may change the host.

## 12. Required tests

Replace old slot/copy expectations with:

```text
test_conductor_uses_one_fixed_codex_process_context
test_performer_inherits_context_without_copying_files
test_api_key_is_never_echoed_logged_or_persisted
test_api_key_replacement_uses_sdk_login_not_config_write
test_device_login_status_and_restart_loss
test_config_read_returns_redacted_source_without_path
test_config_read_validates_bounded_base64_utf8_before_redaction
test_config_patch_only_accepts_openai_base_url
test_config_patch_uses_expected_version
test_config_patch_uses_sdk_typed_app_server_request
test_symphony_never_writes_codex_config_file
test_codex_actions_and_turns_share_one_lock
test_login_logout_and_config_mutations_invalidate_check
test_check_is_manual_and_never_runs_after_a_mutation
test_check_requires_a_real_structured_turn
test_managed_turn_requires_a_ready_check
test_failed_check_does_not_restore_previous_codex_state
test_restart_resets_check_to_unchecked
test_check_state_is_local_durable_sanitized_and_absent_from_podium
test_check_failure_is_visible_in_status_store_and_structured_log
test_not_ready_managed_run_is_visible_in_state_report_log_and_linear
test_live_relay_normalizes_each_performer_codex_operation
test_live_relay_rejects_raw_sdk_fields_paths_and_unknown_request_fields
test_live_routes_keep_the_existing_http_error_envelope
test_status_account_projection_is_bounded_no_store_and_secret_free
test_thread_maps_model_provider_sandbox_and_approval
test_turn_maps_reasoning_effort_summary_and_schema
```

Keep existing Gate rework/block, duplicate/stale, runtime wait, and log
redaction tests.

## 13. Verification cadence

Required sequence:

```text
finish one stage
  -> run all focused tests for that stage
  -> run make test once and collect every failure
  -> group failures by root cause
  -> fix root-cause groups
  -> rerun focused tests and make test
  -> run the single all-phase real E2E
```

Do not fix and rerun one failing case at a time.

## 14. Real E2E

The only runner remains `tools/real_flow.py`.

- OAuth and Linear phases remain independent from Codex configuration.
- Performer uses one per-batch test `CODEX_HOME` derived from
  `.test/codex-home-seed`.
- The test model is fixed to `gpt-5.4`.
- Overall runs only after OAuth, Linear, and Performer pass in the same batch.

Evidence must prove:

- login works without Symphony reading `auth.json`;
- API-key replacement calls the SDK login method and never enters config;
- API host changes through the SDK's typed app-server request;
- login/config changes leave Check `unchecked`;
- a manual real-turn Check is required before plan/execute/gate;
- failed Check does not roll back the new Codex-owned state;
- config source is no-store and secret-safe;
- real plan/execute/gate use explicit SDK policy;
- success closure, one rework then block, duplicate idempotency, stale
  rejection, and secret-safe waits/failures/logs.

## 15. Approval checklist

Approve only if all answers are yes:

- Is one Conductor/one account sufficient for MVP?
- Do ChatGPT login and API-key replacement use only official SDK login calls?
- Is `openai_base_url` the only Podium-edited Codex file-config key needed for
  MVP?
- Is source-format config with standard redaction acceptable?
- Is the SDK's typed app-server client acceptable for Base URL writes, given
  that the pinned top-level `AsyncCodex` class has no config-write convenience
  method yet?
- Is manual Check, with no automatic execution or rollback, acceptable as the
  readiness gate for every new managed turn?
- Are model/provider/sandbox/reasoning clearly SDK run policy?
- Does Podium store no Codex-owned data?
