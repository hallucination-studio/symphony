# ADR-0005: One Conductor uses one Codex context

## Status

Partially superseded by accepted
[ADR-0006](0006-performer-owned-backend-interface.md) on 2026-07-13.

ADR-0006 replaces this ADR's assignment of provider SDK, login/logout,
configuration, Check execution, provider handles, and provider-specific
control ownership to Conductor. The historical rationale below is retained,
but must not be used as an implementation plan for that ownership.

The retained decisions are one fixed backend context per Conductor, one active
account for the Codex implementation, provider-owned credential/config files,
no Podium persistence of provider data, explicit manual Check, policy-only
profiles, and no production copying of provider homes. Their current
implementation boundary is defined by ADR-0006 and the companion
[runtime design](../product/runtime-profiles-backends.md).

This ADR supersedes ADR-0004's Codex config document/hash,
credential table, credential slot, and per-attempt `CODEX_HOME` decisions.
ADR-0004's separate `runtime_profiles`, `performer_profiles`, and
`performer_bindings` remain.

## Decision

The MVP uses one simple rule:

> One Conductor uses one Codex context.

A Codex context is the Codex binary plus the Conductor process's Codex
environment. If `CODEX_HOME` is set, Codex uses it; otherwise Codex uses its
official default. Codex owns `config.toml`, login state, token refresh,
keyring/file credential storage, caches, and future config fields.

Symphony does not manage `auth.json`, copy Codex homes, parse Codex TOML, or
persist Codex config/account data in Podium.

Performer receives only an allowlisted Codex/process environment. It never
inherits Podium or Linear credentials from Conductor.

## Architecture

```text
Podium
  temporary authenticated relay only

Conductor
  uses one fixed Codex process context
  calls Codex login/config
  requires an explicit Codex check before turns
  launches Performer

Codex SDK / app-server
  owns login, credentials, config files, and config validation

Performer
  runs one fenced turn with explicit SDK parameters
```

Podium continues to store Symphony runtime and Performer profiles. Those
profiles contain only Symphony run policy.

## Why there is no Codex “address”

The current Python SDK starts a local `codex app-server` over stdio.
`openai_codex.CodexConfig` has no app-server URL parameter.

Therefore the MVP does not add a Codex socket/WebSocket address. A Conductor
selects Codex with:

```text
optional CODEX_HOME=/path/chosen-by-the-operator
optional codex_bin=/absolute/path/to/codex
```

Symphony does not create or copy that home. This allows the operator to reuse
an existing official Codex login. The selected process environment remains
fixed for the Conductor lifetime.

The upstream model API host is a different concept. Codex stores it in
`config.toml` as `openai_base_url`. Conductor asks Codex app-server to update
that value; Symphony does not store it.

## Login

Podium offers two login actions:

- ChatGPT device-code login through
  `AsyncCodex.login_chatgpt_device_code()`;
- OpenAI API-key login through `AsyncCodex.login_api_key(api_key)`.

Codex stores and refreshes the resulting credentials. Symphony never reads the
credential store.

The API key exists only in the browser request, the in-memory Podium relay, and
the Conductor SDK call. It is never returned, logged, or persisted.

One Conductor has one active account. Account switching means logout and login
again. Multiple stored/selectable accounts inside one Conductor are out of
scope. API-key rotation is another call to `AsyncCodex.login_api_key()`; it is
not represented as a Symphony config field and is never written into
`config.toml` by Symphony.

Starting a login invalidates the previous Check result and leaves the Conductor
`unchecked`, even if the SDK call later fails. A successful login only changes
Codex-owned state; it does not prove that the new account or API key can
complete a model request. The user must run the manual Check described below
before new managed turns are allowed.

## Config

The MVP supports one Podium-managed Codex file-config change:

```text
openai_base_url
```

Conductor sends that change to the official Codex app-server
`config/value/write` operation. Codex validates and writes `config.toml`;
Symphony never opens the file for writing.

The current high-level Python SDK exposes login methods but does not yet expose
a config-write convenience method on `AsyncCodex`. The implementation must use
the SDK's typed app-server client and generated `ConfigValueWriteParams` /
`ConfigWriteResponse` contracts, or upgrade to an SDK version that exposes the
same operation directly. It must not fall back to direct file writes or private
`AsyncCodex._client` access.

The allowed official app-server operations are limited to:

```text
config/read
config/value/write
fs/readFile
```

The adapter must not expose a generic JSON-RPC or filesystem API.

Custom provider creation, arbitrary key editing, and raw TOML editing are out
of scope for the MVP. Operators may still manage advanced Codex config through
normal Codex tooling outside Symphony.

Starting a config mutation invalidates the previous Check result before the SDK
call is made. A successful write leaves the Conductor `unchecked`; a failed or
partially applied write also remains non-ready until the user runs Check.

## Config display

Podium displays the user `config.toml` as source text. It does not render a
Symphony field model or normalized provider table.

Conductor obtains the user config path from `config/read` and reads it through
app-server `fs/readFile`. It validates and decodes the SDK's `dataBase64`
response as bounded UTF-8 before redaction. The browser cannot provide or
receive the path, base64 payload, or raw SDK response.

Before the text reaches the browser, Symphony applies its normal secret
redaction. “Source view” means the original TOML structure, comments, and
ordering are preserved; secret-like values may be replaced with
`[REDACTED]`. Exact unredacted display of a secret-bearing file is out of
scope.

The source is no-store, bounded, and never written to PostgreSQL, runtime
commands, reports, Linear, or logs.

## Managed-run policy

Symphony runtime policy contains only the values Symphony controls per run:

- model;
- model provider;
- sandbox by turn kind;
- approval mode;
- reasoning effort and summary;
- timeouts and retries.

New threads receive model, provider, sandbox, approval, cwd, and
`ephemeral=True`. Turns receive reasoning effort, reasoning summary, sandbox,
approval, and output schema.

Plan and gate are read-only. Execute uses workspace-write. API host and login
state are never passed as thread parameters.

## Concurrency

One simple Conductor `asyncio.Lock` covers:

- login/logout;
- API-host read/write;
- check;
- plan/execute/gate turns.

If Codex is busy, a conflicting action returns `codex_busy`. No secret-bearing
operation is durably queued.

A pending device-code login handle lives only in Conductor memory. If Conductor
restarts, the user starts login again. While login is pending, config/check/run
actions remain busy; the read-only status poll is still allowed.

## Readiness

Check is a separate manual stage. Login, API-key replacement, logout, and Base
URL changes never run it automatically.

Conductor keeps the active Check state and serializes every transition through
the same lock:

```text
unchecked -> checking -> ready
                      -> failed
```

Any login, logout, or config mutation first changes the state to `unchecked`.
A Conductor restart also resets it to `unchecked`. A single local
`codex_control_state` row in `workflow.db` records only the current status,
the previous Check outcome, timestamps, error code, and sanitized reason. It
contains no account, config, path, API host, or credential data. Podium reads
this live state from Conductor and does not persist it.

The user starts Check explicitly. It is a real Codex call using a fresh SDK
session in the same fixed Codex context:

1. initialize the SDK/app-server;
2. use the currently bound runtime profile;
3. start one ephemeral read-only thread;
4. complete one bounded structured turn.

Parsing TOML, reading account status, or starting app-server without completing
a turn cannot pass readiness.

Only `ready` allows a new plan, execute, or gate turn. `unchecked` returns
`codex_check_required`; a failed Check returns `codex_check_failed` with a
sanitized reason. Logout may return the more specific `codex_login_required`.
If a managed run reaches this gate, Conductor records the sanitized backend
setup failure in durable run/work-item state, structured logs, the managed-runs
view, and the Linear projection. It must not silently skip the dispatch or wait
only in local stdout.

There is no rollback. If login, API-key replacement, or Base URL modification
leaves Codex unusable, Check fails and the current Codex-owned state remains in
place. The user corrects the settings or logs in again, then manually reruns
Check. Symphony never retains an old API key or OAuth session for restoration.

## Data boundary

Podium does not store:

- Codex config text or hash;
- API host;
- Codex account or auth method;
- API key or OAuth data;
- `CODEX_HOME` or config path;
- check result.

The small sanitized Check record exists only in Conductor's local
`workflow.db`. It gates turns and supports the live status request, but it is
not a runtime profile, credential record, or Podium fact. Startup overwrites
its current status to `unchecked` while retaining the previous sanitized
result as operator evidence.

`project.configure` carries only Symphony profile ids, policy documents/hashes,
binding generation, repository, and Linear project binding.

There is no `performer_credentials` table and no slot field.

## Scope ledger

### Authorized

- One fixed Codex process context and one active account per Conductor.
- SDK login/logout, including ChatGPT device login and API-key replacement.
- App-server-owned `openai_base_url` read/write.
- Manual real-turn Check as the readiness gate.
- Redacted source-format `config.toml` display.
- Explicit SDK thread/turn policy.
- Removal of slot/copy/TOML-validator/auth-reconciliation code.

### Required consequences

- Conductor owns one active Check state and blocks new managed turns until it
  is `ready`.
- Conductor persists one small secret-free Check status row for failure
  visibility; Podium persists none of it.
- Starting login, logout, or config mutation invalidates readiness before the
  SDK call.
- Conductor restart requires another manual Check.
- SDK and config failures remain visible with sanitized reason codes.
- A managed run blocked by Check readiness uses the existing durable backend
  failure and Linear projection surfaces.

### Out of scope

- Multiple account slots.
- Arbitrary Codex config editor.
- Custom-provider credential upload.
- Podium vault/KMS.
- Remote app-server endpoint.
- Direct `auth.json` or config file management.
- Durable login jobs.
- Automatic Check after login or config changes.
- Credential or config rollback after a failed Check.
- Another runtime transport, scheduler, or E2E runner.

### Assumptions requiring approval

- None. The user approved this ADR and its companion runtime design on
  2026-07-13.

### Deferred ideas

- Multiple selectable accounts per Conductor.
- Automatic Check and transactional rollback.
- A wider Podium editor for Codex providers or arbitrary config keys.

### Accepted approval points

Approval of this ADR confirms:

1. one Conductor has one Codex context and one active account;
2. ChatGPT login and API-key replacement use official SDK login methods;
3. Podium file-config editing is limited to `openai_base_url` in the MVP;
4. `config.toml` is shown as source text with standard secret redaction;
5. the SDK's typed app-server client counts as the Codex SDK control surface;
6. Check is manual, gates all new managed turns, and never rolls changes back.

## Real E2E

Production does not copy Codex files. The real-E2E harness still creates one
isolated per-batch test `CODEX_HOME` from the fixed `.test` seed, as required by
repository safety rules.

The one all-phase run must prove:

- login works without Symphony reading `auth.json`;
- API-key replacement uses the SDK login method and never enters Codex config;
- API host is changed by the SDK's typed app-server client, not direct file
  editing;
- login/config changes invalidate readiness, and a manual real-turn Check is
  required before the next managed turn;
- a failed Check does not restore the previous account, API key, or Base URL;
- config source display is no-store and does not leak secrets or paths;
- real `gpt-5.4` plan/execute/gate use explicit SDK parameters;
- success closure, one Gate rework then block, duplicate idempotency, stale
  rejection, and secret-safe waits/failures/logs.

## Implementation cutover

Remove:

- Codex config documents/hashes and credential fields;
- `performer_api` Codex TOML validation;
- Conductor credential slots and selection;
- production Codex-home copying and `auth.json` copy-back;
- forced file-credential-store override;
- slot APIs, CLI, and slot tests.

Add:

- one Conductor Codex controller using public SDK login and official app-server
  config operations;
- device-code/API-key login and logout;
- API-host read/write through the SDK's typed app-server client;
- in-memory manual Check state that gates new managed turns;
- redacted config source view;
- explicit thread/turn policy mapping;
- focused tests, one full `make test` failure collection grouped by root cause,
  and the single real-E2E batch.

## Official references

- [Codex SDK](https://developers.openai.com/codex/codex-sdk/)
- [Codex app-server](https://developers.openai.com/codex/app-server/)
- [Advanced configuration](https://developers.openai.com/codex/config-advanced/)
- [Authentication](https://developers.openai.com/codex/auth/)

## Consequences

Benefits:

- Codex owns Codex files and credentials.
- Symphony removes most credential/config lifecycle code.
- The Podium surface is small and understandable.
- New Codex config keys do not break Symphony.

Tradeoffs:

- One Conductor cannot keep multiple selectable accounts.
- Podium edits only the built-in OpenAI API host.
- API-key entry passes transiently through Podium memory.
- A restart or any login/config mutation requires another manual Check.
- Failed changes are not rolled back; the current Codex context remains blocked
  until the user corrects it and Check passes.
- Secret values in the config source are redacted.
