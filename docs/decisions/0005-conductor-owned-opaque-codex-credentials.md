# ADR-0005: Conductor-owned opaque Codex credentials and live Podium inspection

## Status

Proposed on 2026-07-13. No production implementation is authorized until the
user approves this document.

If accepted, this ADR supersedes only the credential ownership, credential
selection, readiness persistence, and credential-reporting parts of ADR-0004.
ADR-0004 continues to govern non-secret `performer_profile` and
`runtime_profile` configuration unless a later decision explicitly moves those
profiles out of Podium too.

## Objective

Support both official Codex sign-in forms without making Symphony understand or
track Codex's private credential schema:

- ChatGPT sign-in created by `codex login`, including OAuth refresh performed by
  Codex itself;
- API-key sign-in created by the official Codex CLI;
- multiple independent Codex accounts or API keys on one Conductor;
- one locally selected Codex credential slot for the Conductor's bound project;
- a live Podium view of the selected slot plus an explicit on-demand fresh
  check, without persisting credential-management data in Podium.

The design treats a Codex file-based credential as opaque Codex-owned bytes.
Symphony may move those bytes between controlled local directories, but it must
not parse, normalize, convert, fingerprint, or infer fields inside
`auth.json`.

## Source constraints

OpenAI's current Codex authentication documentation is the external source of
truth for this adapter:

- Codex supports both ChatGPT sign-in and API-key sign-in for local work.
- `cli_auth_credentials_store = "file"` stores cached login state in
  `CODEX_HOME/auth.json`.
- Codex refreshes active ChatGPT sessions automatically during use.

See [Codex authentication](https://learn.chatgpt.com/docs/auth), especially
"Login caching" and "Credential storage". That documentation deliberately does
not promise the internal JSON field schema, which is why this ADR treats the
file as opaque.

## Scope ledger

### Authorized

- Codex OAuth and API-key credentials use the same opaque local-slot path.
- Codex, rather than Symphony, decides whether a credential file is valid.
- A fresh bounded Codex check determines readiness.
- Podium queries Conductor for the current credential-management view and does
  not persist that view or its check result.
- Multiple local Codex slots are supported.

### Required consequences

- Podium's `performer_credentials` records and credential fields in
  `performer_bindings` are removed from the approved design.
- `project.configure` stops carrying `credential_id`, `credential_ref`,
  `auth_method`, and `account_hint`.
- Conductor becomes the source of truth for local slot inventory and the slot
  selected by its single project instance.
- Podium needs an ephemeral request/reply path over the existing outbound
  runtime connection because it cannot call a customer-side Conductor directly.
- Real E2E must test one official ChatGPT login slot and one API-key slot through
  the same code path.

### Out of scope

- Uploading credentials through Podium, the browser, Linear, or a runtime
  command;
- Podium-side KMS, vault, keyring, credential rotation, or recovery;
- interpreting `auth.json` fields or distinguishing OAuth from API key in
  Symphony contracts;
- reading browser cookies, local storage, or extension tokens;
- making the live management relay durable or highly available in the MVP;
- moving non-secret Performer/runtime profiles out of Podium;
- accepting ambient `~/.codex` directly as a managed runtime input.

### Assumptions requiring approval

None beyond approving this ADR. The final approval questions are listed at the
end so the implementation boundary is explicit.

## Decision summary

The ownership boundary becomes:

```text
Podium
  owns: user/project authorization, Conductor identity and binding,
        non-secret Performer/runtime profiles, dispatch, live-query relay
  stores no: Codex slots, selected slot, auth method, auth bytes,
             credential readiness, credential check output/result

Conductor
  owns: local Codex slot inventory, selected slot, local slot lock,
        opaque credential materialization, live credential check

Codex
  owns: auth.json schema, OAuth/API-key interpretation, token refresh,
        provider authentication, actual readiness verdict

Performer
  receives: one fenced turn and one isolated attempt CODEX_HOME
  never receives: Podium or Linear credentials
```

There is no Symphony `api_key` versus `chatgpt_oauth` execution branch. Both are
official Codex file-based login state in a selected local slot. If Codex changes
its internal JSON fields, Symphony does not change unless Codex changes the
documented file-storage contract itself.

## Persistence model

### Podium persistence

Podium continues to persist the data required to authorize and route the
product:

- users/workspaces;
- Linear installations and selected projects;
- enrolled Conductor identities and project bindings;
- non-secret `runtime_profiles` and `performer_profiles`;
- dispatches, managed-run reports, and other existing product state.

Podium must not persist any of the following:

- a `performer_credentials` row;
- a credential slot id or selected slot id;
- `auth_method` or `account_hint`;
- a Codex home path;
- `auth.json` bytes or any derived field/fingerprint;
- live credential readiness or the result of a credential check;
- stdout/stderr from `codex login status` or a live Codex check.

`performer_bindings` therefore selects only a `performer_profile`. Credential
selection is not part of the Podium binding and does not increment the Podium
binding generation. A local selection change is immediately effective for the
next Conductor attempt.

The phrase "Podium stores no data" in this ADR refers to Codex credential
management data. It does not remove the product's existing routing, auth,
profile, dispatch, or managed-run persistence.

### Conductor persistence

Conductor stores credential slots under its own data root:

```text
<conductor-data>/performer-credentials/
  selection.json
  <slot-id>/
    slot.json
    CODEX_HOME/
      auth.json
      config.toml                 # optional operator defaults
      version.json                # optional Codex-owned state
      models_cache.json           # optional Codex-owned state
```

`slot.json` is Symphony metadata, not Codex credential data:

```json
{
  "version": 1,
  "slot_id": "codex-main",
  "display_name": "Main Codex account",
  "performer_kind": "codex"
}
```

It must not contain `auth_method`, email, account id, token metadata, provider
key names, paths outside the slot, or any value derived from credential bytes.

`selection.json` contains only the selected `slot_id` and a local monotonically
increasing selection generation. The generation fences concurrent local
updates; it is not sent to or persisted by Podium.

Slot ids are operator labels, not credential fingerprints. Multiple slots may
contain OAuth sessions, API keys, or a mix; Symphony does not know which.

## Local provisioning

The operator prepares a dedicated managed Codex home, never the ambient
`~/.codex` directory. The planned local commands are:

```bash
# Create an empty managed slot and print its controlled CODEX_HOME path.
conductor performer-credential init --id codex-main --name "Main Codex account"

# ChatGPT sign-in. Codex writes its own file-based login state.
CODEX_HOME=<printed-path> codex login

# API-key sign-in. The key is read from stdin and is never a command argument.
printenv OPENAI_API_KEY | CODEX_HOME=<printed-path> codex login --with-api-key

# Select the slot for this Conductor's one bound project.
conductor performer-credential select --id codex-main

# Run the same bounded check used by live Podium inspection.
conductor performer-credential check --id codex-main --live
```

The CLI names above are part of the proposed interface, not existing behavior.
Implementation must preserve file mode `0600` for `auth.json`, reject symlinks
and path escapes, and require `cli_auth_credentials_store = "file"` for managed
slots. Keyring extraction or export is not part of the MVP.

An import command may copy a fixed, operator-approved Codex home into a new
slot, but it must reject a source that is `~/.codex`, resolves to `~/.codex`, or
contains symlinked approved files. Import copies opaque files; it does not parse
credential fields.

## Opaque materialization and OAuth refresh

Each Performer attempt still receives a fresh isolated `CODEX_HOME`; the local
slot remains the credential source of truth. Materialization is serialized by
an exclusive per-slot lock:

1. Acquire the selected slot lock.
2. Create a fresh attempt `CODEX_HOME` under the Conductor instance state.
3. Copy the approved Codex state files byte-for-byte from the slot. Do not parse
   `auth.json`.
4. Apply the validated non-secret Podium runtime profile to the attempt's
   `config.toml`.
5. Run the credential check or Performer turn.
6. If Codex rewrote `auth.json`, atomically replace the slot's `auth.json` with
   the resulting opaque file, preserve mode `0600`, and fsync the parent
   directory before releasing the lock.
7. Delete the attempt home according to the existing artifact-retention policy;
   retained evidence must never include credential files.

This copy-back step is required for ChatGPT OAuth refresh. Without it, a token
refresh or refresh-token rotation performed inside an isolated attempt could be
lost and the next attempt could reuse stale login state. API-key state follows
the same path and normally copies back unchanged.

No two checks or turns may use the same slot concurrently. The MVP chooses
correct refresh semantics over parallelism within one credential slot. Separate
slots may run independently.

## Readiness check

Symphony does not declare a slot ready because a file exists or because a JSON
field is present.

### Precheck

Conductor may run `codex login status` as a fast precheck. Its stdout/stderr is
discarded before application logging because current Codex versions may print a
masked API key or account information. Only the exit code and a bounded
sanitized error category may be retained.

A successful login-status command is not enough to set `ready` because it does
not prove that the selected model/provider request path works.

### Authoritative live check

`check.status = "passed"` requires one real, bounded Codex turn using:

- the selected local slot;
- the same validated runtime profile that the next Performer turn will use;
- the configured model, including the real-E2E requirement to use `gpt-5.4`;
- an empty temporary workspace;
- read-only sandboxing, no approval prompt, no tools, and ephemeral session
  state;
- a fixed output schema that accepts only `{"ok": true}`;
- a short timeout and bounded retry policy;
- captured output that is sanitized and then discarded, not returned to
  Podium.

The check result is one of:

```text
passed
failed: managed_codex_login_required
failed: managed_codex_check_timeout
failed: managed_codex_provider_unavailable
failed: managed_codex_auth_rejected
failed: managed_codex_check_invalid_result
failed: managed_codex_check_failed
```

Provider errors such as an HTTP 502 remain provider-path failures. They must not
be rewritten as missing `auth.json` unless Codex's own result specifically
classifies the failure as authentication-related.

## Live Podium inspection

Conductor is customer-side and outbound-only. Podium must not attempt a direct
HTTP call to a Conductor host. It also must not use the existing durable
`runtime_commands` table for credential inspection because command and result
JSON would then be persisted.

The MVP adds an ephemeral request/reply lane beside the durable command lane:

```text
Browser -> Podium: request fresh credential view
Podium: authorize user/conductor, create in-memory request with 15s TTL
Conductor -> Podium: authenticated outbound live-poll
Podium -> Conductor: lease the in-memory read-only request
Conductor: run local list/check and build a closed sanitized response
Conductor -> Podium: authenticated live-reply
Podium -> Browser: return the response once
Podium: delete the request and response from memory
```

The relay must not write the request payload, reply payload, slot list, or check
result to PostgreSQL, Redis, files, object storage, runtime reports, or
`runtime_commands.result_json`. Podium may log only request id, conductor id,
operation, duration, and sanitized terminal outcome.

The MVP may use an in-process waiter map because the current real-flow Podium is
a single process. A multi-process deployment requires sticky routing or a
separately approved non-durable message bus; silently falling back to database
persistence is forbidden.

## Proposed interfaces

### Browser-facing live inventory

```http
GET /api/v1/conductors/{conductor_id}/performer-credentials/live
```

Success response:

```json
{
  "version": 1,
  "conductor_id": "conductor-1",
  "observed_at": "2026-07-13T00:00:00Z",
  "selection": {
    "slot_id": "codex-main",
    "selection_generation": 3
  },
  "slots": [
    {
      "slot_id": "codex-main",
      "display_name": "Main Codex account",
      "performer_kind": "codex",
      "selected": true,
      "precheck": {
        "status": "passed",
        "observed_at": "2026-07-13T00:00:00Z",
        "error_code": null,
        "sanitized_reason": null
      }
    }
  ]
}
```

The response must never contain an auth method, account/email hint, home path,
file name, token metadata, command output, provider Authorization detail, or
credential-derived fingerprint.

The endpoint returns `503 conductor_live_query_unavailable` when the Conductor
is offline or does not reply before the TTL. It must not return a stale cached
snapshot as if it were current.

The GET may run the output-discarding `codex login status` precheck. It must not
run a model turn, claim authoritative readiness, or incur model usage merely
because a page was loaded.

### Browser-facing live check

```http
POST /api/v1/conductors/{conductor_id}/performer-credentials/{slot_id}/checks
```

The POST explicitly runs the authoritative bounded Codex turn and returns only
the fresh result:

```json
{
  "version": 1,
  "conductor_id": "conductor-1",
  "slot_id": "codex-main",
  "checked_at": "2026-07-13T00:00:00Z",
  "check": {
    "status": "passed",
    "error_code": null,
    "sanitized_reason": null
  }
}
```

Using POST is intentional: the operation consumes model capacity and may cause
Codex to refresh its local OAuth state. Podium still does not persist the
request or result. A browser refresh must not silently repeat a previous check.

### Runtime-facing ephemeral lane

```http
POST /api/v1/runtime/live/lease
POST /api/v1/runtime/live/reply
```

The lease request uses the existing runtime bearer token. Allowed operations
are closed in the MVP:

```json
{
  "request_id": "opaque-random-id",
  "operation": "performer_credentials.inspect",
  "deadline": "2026-07-13T00:00:15Z"
}
```

The only operations are:

```text
performer_credentials.inspect  # inventory plus non-authoritative precheck
performer_credentials.check    # explicit bounded live Codex turn
```

No arbitrary command, path, shell argument, model prompt, environment value, or
credential value is accepted from Podium. The reply is capped at 16 KiB and is
validated against the closed browser-response schema before Podium forwards it.

Podium cannot create, import, delete, select, or edit credentials in this MVP.
Those mutations happen through the local Conductor CLI. The live check is an
explicit diagnostic action, not credential management. A later remote-mutation
design would require idempotency, stronger audit semantics, and separate
approval.

## Execution failure behavior

Before a managed turn, Conductor resolves the currently selected local slot. A
missing, unreadable, locked, or failed slot blocks the turn with a concrete
sanitized reason. The failure must appear in:

- Conductor durable managed-run state;
- the correlated Conductor/Performer log;
- the Podium managed-run view through the existing managed-run report path;
- the relevant Linear runtime-wait or blocked projection when human action is
  required.

This does not violate the no-persistence rule: Podium may persist the existing
managed-run failure category and actionable summary, but it must not persist a
credential snapshot, slot inventory, selected slot id, auth method, or check
output.

Required structured events include:

```text
conductor_codex_slot_check_started
conductor_codex_slot_check_completed
conductor_codex_slot_check_failed
conductor_codex_slot_materialized
conductor_codex_slot_refresh_committed
podium_live_conductor_query_started
podium_live_conductor_query_completed
podium_live_conductor_query_timed_out
```

Logs include correlation ids and sanitized error fields, never slot paths,
credential bytes, `auth.json` contents, Codex status output, emails, masked API
keys, or Authorization headers.

## Security constraints

- The local slot root is fixed below the Conductor data root.
- Slot ids use a strict bounded identifier grammar and cannot become paths.
- Symlinked slot directories or approved files are rejected.
- Credential files are never included in retained attempt artifacts.
- `auth.json` always uses mode `0600`; slot directories are owner-only.
- Copy-back is atomic and occurs only while holding the exclusive slot lock.
- The live Podium endpoint requires the authenticated user to own the target
  Conductor.
- Runtime live lease/reply uses the existing scoped runtime bearer and checks
  that the request belongs to that runtime.
- Live request ids are random, single-use, bounded by TTL, and rejected after
  completion or expiry.
- Browser and runtime responses use closed schemas and size limits.
- External Codex output is untrusted data. Only the fixed structured `ok`
  result and sanitized error category affect readiness.
- Podium never receives raw local paths or credential-derived values.

## Migration from ADR-0004 and the checkpointed code

After approval, implementation must remove rather than compatibility-wrap the
old credential contract:

1. Remove `performer_credentials` from the fresh Podium schema and store API.
2. Remove `credential_id` from `performer_bindings`.
3. Remove credential metadata from profile bundles, summaries, runtime reports,
   `project.configure`, and shared `PerformerProfileConfig` contracts.
4. Add Conductor-local slot metadata, selection, locking, opaque
   materialization, and refresh copy-back.
5. Add the ephemeral live inventory/check lane and Podium BFF endpoints.
6. Change real-flow setup to select one local test slot; never upload it to
   Podium.
7. Delete tests that assert Podium credential persistence and replace them with
   tests that prove the absence of that persistence.

There is no legacy compatibility shim. A pre-MVP database may be recreated; if
a migration must preserve existing non-secret profile rows, it drops only the
credential table/columns and requires local slot selection before the next
managed run.

## Testing strategy and acceptance rubric

### Focused contract tests

- An opaque `auth.json` containing arbitrary bounded bytes is copied without
  field inspection; only Codex decides whether those bytes are usable.
- Changing internal JSON field names does not change Symphony behavior.
- Symlinks, path escapes, missing files, invalid permissions, and oversized
  files fail closed with sanitized codes.
- A Codex-rewritten `auth.json` is atomically copied back under the slot lock.
- Two attempts cannot use one slot concurrently; two different slots can.
- `project.configure` and Podium profile summaries contain no credential fields.
- Podium schema and store expose no `performer_credentials` persistence.
- The live relay writes neither request nor response to the database.
- Live replies reject unknown fields, secret-like fields, and payloads over
  16 KiB.
- Logs preserve error category and correlation ids without paths or credential
  output.

### Real checks

1. Stage one fixed managed Codex slot from an already authorized official
   ChatGPT login. The test must reuse it rather than authorizing on every run.
2. Stage a second fixed managed Codex slot from an already configured official
   API-key login. The test must reuse it rather than reprovisioning the key on
   every run.
3. Run the same local live-check code for both; both must pass without an
   `auth_method` branch in Symphony.
4. Corrupt or revoke each slot independently and verify a concrete sanitized
   failure without token leakage.
5. Query the live Podium inventory endpoint and verify that it reflects the
   current Conductor selection without running a model turn; then explicitly
   POST a live check and verify the fresh result.
6. Restart Podium and verify the previous credential view is unavailable until
   a new live query completes, proving no snapshot persistence.
7. Run one real Performer turn with the selected test slot, the fixed test
   profile, and `gpt-5.4`.
8. Audit PostgreSQL, runtime command rows, reports, browser responses, logs,
   Linear comments, and retained artifacts for credential leakage.

### Batch verification cadence

Implementation follows the required batch rhythm:

```text
complete one coherent design slice
-> run all focused tests for that slice
-> run make test once and retain the complete failure set
-> group failures by root cause
-> fix each root-cause group as one change
-> rerun focused tests and make test
-> run tools/real_flow.py --phase all once for final acceptance
```

Real E2E must execute OAuth, Linear, Performer, and Overall under one `run_id`.
It must not run one phase, patch one symptom, and repeat until green.

## Alternatives rejected

### Parse OAuth and API-key JSON shapes in Symphony

Rejected. Codex owns that private schema and already supports both sign-in
methods. Field-level validation couples Symphony to an implementation detail,
creates false mismatches across Codex versions, and duplicates Codex's own
auth logic.

### Store non-secret credential metadata in Podium

Rejected for this design. Even `auth_method`, account hints, selected slot ids,
and readiness snapshots create a second source of truth that can drift from the
local Conductor. Podium should display a fresh local observation instead.

### Send `auth.json` through Podium

Rejected. Runtime commands are durable and observable. Sending login state
through them expands the secret blast radius and contradicts the local Codex
login model.

### Use durable `runtime_commands` for live inspection

Rejected. Its command and result JSON are stored in PostgreSQL. Credential
inspection is intentionally ephemeral and read-only.

### Accept `codex login status` as readiness

Rejected. It may reveal masked account/key information in output and does not
prove that the configured model/provider request path succeeds.

### Use the selected slot directly without an attempt copy

Rejected. It lets one attempt mutate shared Codex state while another runs and
weakens attempt isolation. Opaque copy plus locked atomic refresh copy-back
preserves both isolation and Codex-owned refresh behavior.

## Approval questions

Approval of this ADR means approval of all four decisions below:

1. Podium keeps non-secret Performer/runtime profiles but stores no Codex
   credential inventory, selection, auth method, readiness, or check result.
2. Conductor owns multiple opaque local Codex slots and one local selection;
   Symphony never parses or distinguishes OAuth/API-key `auth.json` fields.
3. Readiness requires a real bounded Codex turn; login status alone is only a
   precheck.
4. Podium exposes live inventory and an explicit diagnostic check over a new
   non-durable outbound request/reply lane; local CLI owns every slot mutation.

Implementation must wait for explicit user approval.
