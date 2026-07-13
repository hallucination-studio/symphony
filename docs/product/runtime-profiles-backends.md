# Runtime profiles and Performer backends

Status: target runtime design accepted on 2026-07-13. This document implements
the ownership correction in
[ADR-0006](../decisions/0006-performer-owned-backend-interface.md) and retains
the still-valid policy/no-store decisions from
[ADR-0005](../decisions/0005-conductor-owned-opaque-codex-credentials.md).

## 1. Target

Symphony keeps provider details behind Performer:

```text
Podium
  authenticated no-store relay and capability-driven UI
    |
    | provider-neutral control commands
    v
Conductor
  durable orchestration, readiness, generic subprocess lane
    |
    | performer_api JSON contracts
    v
installed performer command
  PerformerBackend interface and explicit registry
    ├── CodexBackend -> Codex SDK / app-server
    ├── ClaudeBackend -> future separately approved adapter
    └── test backend
```

The dependency direction is fixed:

```text
performer_api <- performer
performer_api <- conductor
performer_api <- podium, when a shared wire contract is needed
```

Conductor never imports `performer`, a provider SDK, or provider-generated
types. Provider SDKs, provider process/config/auth logic, and provider response
parsing may exist only in Performer-owned backend implementation modules.

## 2. Product model

### Runtime profile

A runtime profile contains only Symphony execution policy:

```json
{
  "runtime_kind": "codex",
  "execution_policy": {
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
}
```

The example is the canonical real-E2E fixture, not a production default.
Runtime policy is secret-free, strictly validated, canonically hashed, and
carried in `project.configure` and every fenced turn request.

The profile contains no provider config document, provider home, credential
reference, account, API key, token, API host, or Check result.

### Performer profile

A Performer profile selects:

- one closed `performer_kind`;
- one runtime profile;
- secret-free turn policy;
- the corresponding policy hashes.

The MVP registry contains only approved backend kinds. Codex is the first
production implementation. The data model supports additional approved
implementations, but there is no dynamic plugin loader, entry-point discovery,
provider marketplace, or per-run backend switching.

### Backend process context

One Conductor selects one backend kind and one fixed backend process context
for its lifetime. The context is the installed `performer` command plus a
fixed, allowlisted environment such as:

```text
HOME
optional provider-owned home variable such as CODEX_HOME
optional approved provider binary path
PATH and required process/runtime variables
```

The same fixed context is used by control and turn subprocesses. Conductor
selects and passes it, but does not understand provider config/auth semantics.
Performer passes the relevant values to the selected backend implementation.

Production does not create per-attempt provider homes, copy provider credential
files, parse provider configuration files, or reconcile credentials. The real
E2E harness may stage one isolated per-batch context from the approved fixed
seed required by repository safety rules.

## 3. Interface layers

### Shared `performer_api` contracts

Everything that crosses a process or package boundary uses dependency-free,
closed contracts in `performer_api`:

```text
PerformerTurnRequest
PerformerTurnResult
PerformerControlRequest
PerformerControlResult
PerformerCapabilities
PerformerReadinessState
PerformerControlError
```

These contracts contain no SDK objects, generated provider types, raw provider
responses, secrets, local config paths, credential-store paths, or arbitrary
JSON-RPC payloads.

Control requests form a discriminated union for exactly:

```text
status
login
session.delete
config.read
config.write
check
```

Results are also discriminated by operation. Unknown fields and unknown
operations fail closed. Every error uses:

```text
error_code
sanitized_reason
action_required
retryable
attempt_number, when applicable
next_action
```

### Internal Performer interface

Performer owns a Protocol or ABC with the semantic surface:

```python
class PerformerBackend(Protocol):
    @property
    def kind(self) -> str: ...

    def capabilities(self) -> PerformerCapabilities: ...

    async def control(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
    ) -> PerformerControlResult: ...

    async def run_turn(
        self,
        request: PerformerTurnRequest,
    ) -> PerformerTurnResult: ...
```

The implementation may split these methods internally, but the following are
hard invariants:

- backend selection occurs only inside Performer;
- the registry is explicit and closed;
- each implementation validates its provider's untrusted responses;
- each implementation maps generic policy/config/login requests to its SDK;
- each implementation normalizes and sanitizes before returning;
- unsupported operations return
  `performer_operation_not_supported`, not provider exceptions.

The required contract suite runs against the production Codex implementation
with fake SDK boundaries and against a deterministic test backend. A production
Claude implementation is added only after its SDK/auth/config design is
separately approved.

## 4. Capabilities

`PerformerCapabilities` is closed, versioned, and provider-neutral. It declares:

- backend kind and display label;
- supported turn kinds;
- supported login methods, expressed as logical kinds such as `device_code`
  and `api_key`;
- whether logout/session deletion is supported;
- editable logical settings, initially only `api_base_url` where supported;
- whether a sanitized source-format config view is supported;
- whether manual Check is supported;
- protocol and capability versions.

Capabilities control validation and UI visibility. They do not grant arbitrary
provider calls. Conductor and Podium must not branch on SDK classes or parse a
provider error to infer support.

For the Codex implementation:

- logical `device_code` maps to the official ChatGPT device-code login;
- logical `api_key` maps to the official API-key login;
- logical `api_base_url` maps inside Performer to Codex
  `openai_base_url` through the SDK's typed app-server operation;
- config source is read and redacted inside Performer;
- Check and turns use the Codex SDK inside Performer.

Those mappings are CodexBackend details. They are not Conductor behavior and
must not be reproduced in Podium route or Web code.

## 5. Control process protocol

Conductor invokes an installed control mode, conceptually:

```bash
performer control
```

The exact CLI flags are implementation detail, but transport rules are fixed.

### Secret-free operations

Status, capability discovery, sanitized config reads, and Check results may use
bounded stdin/stdout JSON. They must not expose provider paths or raw SDK
payloads.

### Secret-bearing operations

API keys and similar login material travel only through request memory and
Performer stdin or an equivalent pipe. `PerformerControlRequest` contains only
metadata and the expected secret-input kind/length; the value follows as a
separate bounded length-delimited stdin frame:

```text
browser request memory
  -> Podium relay memory
    -> Conductor relay memory
      -> Performer control metadata frame + secret-input frame
        -> provider SDK
```

They are never written to turn/control JSON files, workflow SQLite, Podium
PostgreSQL, logs, reports, Linear, caches, or browser response bodies.

### Long-running device login

A device-code login may remain active while the user authorizes it. Performer
owns the provider SDK login handle and emits normalized bounded events such as:

```text
login.pending
login.succeeded
login.failed
```

The pending event may include the provider-approved verification URL, user
code, and expiry needed by the operator. Conductor owns only the generic
subprocess handle and correlation ids. Cancellation closes or terminates the
control process; no provider handle enters Conductor state.

After a Conductor restart, an in-flight login becomes `lost`. The user starts a
new login. Symphony does not reconstruct or persist a provider SDK handle.

### Protocol validation

Control stdin is a bounded framed protocol: a closed metadata frame followed by
an optional length-delimited secret-input frame. Control stdout is single-line
JSON or JSON-lines with explicit version, operation, request id, event/result
kind, and bounded payload. Any
unexpected stdout, malformed JSON, unknown event, mismatched request id, or
oversized payload fails with `performer_control_protocol_invalid` and is
visible in durable state and logs.

Performer stderr is captured as a sanitized correlated log stream. It is not a
second response channel.

## 6. Managed turn protocol

Plan, execute, and gate retain fenced request/result files:

```text
Conductor writes a secret-free fenced request
  -> launches installed performer command
  -> Performer validates RuntimePolicy and TurnContext
  -> registry selects the backend
  -> backend maps policy to SDK calls
  -> Performer writes one fenced normalized result
  -> Conductor validates and applies the expected result
```

The request includes execution policy, turn policy, repository/work-item
context, result schema, and fencing identifiers. It does not include provider
credentials or config source.

The Codex backend maps model, provider, approval, reasoning, sandbox, cwd,
schema, timeouts, and retry limits to the pinned official SDK. No other role
performs this mapping.

## 7. Conductor ownership

Conductor owns generic orchestration only:

- one fixed Performer environment;
- one asynchronous control/turn lane per Conductor;
- subprocess start, heartbeat, timeout, cancellation, exit, and log capture;
- control protocol parsing through `performer_api`;
- one durable `performer_control_state` row;
- readiness gating and exact-phase resume;
- managed-run state, fencing, retries, Linear projection, and Podium reports.

Conductor does not own:

- provider SDK clients or generated types;
- provider account/config parsing;
- provider login handles;
- provider-specific config keys;
- provider response/error parsing;
- provider-specific request classes;
- a `CodexController`, `ClaudeController`, or equivalent provider controller.

The lane serializes conflicting control and turn work. It must not hold an
event-loop-blocking synchronous `subprocess.run`; process waits and stream
reads remain asynchronous so dispatch/lease heartbeats and status calls stay
alive.

When busy, Conductor returns a generic `performer_busy` with the active
operation kind and safe correlation ids. It does not expose provider internals.

## 8. Readiness and durable state

Conductor persists one local secret-free row:

```text
performer_control_state
  backend_kind
  capability_version
  current_status
  checked_execution_policy_sha256
  last_check_status
  last_check_started_at
  last_check_finished_at
  error_code
  sanitized_reason
  action_required
  retryable
  next_action
```

Allowed current readiness states are:

```text
unchecked
checking
ready
failed
```

Login, logout, and config mutations invalidate readiness before the mutation
can authorize another turn. Performer returns the normalized post-operation
readiness state; Conductor persists it without provider interpretation.

Conductor startup sets current readiness to `unchecked` while retaining the
last sanitized Check outcome as evidence. A successful manual Check is the only
transition to `ready`. The successful Check is bound to the current execution
policy hash; a relevant policy change requires another Check.

Before starting plan, execute, or gate, Conductor requires compatible `ready`
state. Otherwise the managed run blocks with a generic actionable reason such
as `performer_check_required` or `performer_login_required`. The same reason is
recorded in SQLite, structured logs, Podium managed-runs, and Linear. After a
manual Check passes, Conductor resumes the exact prior workflow phase without
duplicating a task or attempt.

There is no automatic Check and no rollback of provider-owned login/config
state. The operator corrects the backend and manually checks again.

## 9. Podium live relay

Podium exposes owner-authorized, no-store operations rooted at the Conductor's
Performer resource:

| HTTP surface | Live operation | Result |
|---|---|---|
| `GET /api/v1/conductors/{id}/performer` | `performer.status` | capabilities, normalized account/login/readiness status |
| `POST /api/v1/conductors/{id}/performer/login` | `performer.login` | start a supported login method |
| `DELETE /api/v1/conductors/{id}/performer/session` | `performer.session.delete` | cancel pending login or logout |
| `GET /api/v1/conductors/{id}/performer/config` | `performer.config.read` | supported logical settings and optional redacted source |
| `PATCH /api/v1/conductors/{id}/performer/config` | `performer.config.write` | mutate one supported logical setting |
| `POST /api/v1/conductors/{id}/performer/check` | `performer.check` | run explicit readiness Check |

Podium validates the generic request/result contract, preserves lease and reply
fencing, rejects duplicate or stale replies, enforces timeouts/rate limits, and
sets no-store headers. It never persists a live control request/result or
forwards raw Performer stdout.

Live operation names must not contain `codex`, `claude`, SDK method names, or
provider config keys.

## 10. Podium Web

The Runtimes view uses one Performer control drawer. It renders:

- selected backend label and capability version;
- only login methods declared by capabilities;
- normalized account and login state;
- supported logical config fields;
- optional sanitized source-format config;
- explicit Check action and current/last readiness evidence.

The browser may display provider branding supplied as bounded capability data,
but it does not embed provider-specific SDK semantics in route names, query
keys, or response parsers.

API keys, device codes, config source, and login results are transient UI state
only. They are excluded from TanStack Query/mutation caches, cleared on
completion or drawer close, and never logged. Login/config mutations never
trigger Check automatically.

## 11. Persistence boundary

Podium persists:

- runtime/Performer profile ids and kinds;
- execution/turn policy and hashes;
- Performer binding generation;
- project/Conductor binding;
- ordinary command lease/reply metadata and sanitized reports.

Podium does not persist:

- provider config text or paths;
- provider account or auth method;
- API keys, OAuth data, tokens, or credential-store contents;
- device-login codes or handles;
- readiness/Check state;
- provider SDK responses.

Conductor persists only the generic secret-free readiness row and normal
managed-run evidence. Provider-owned state remains in the fixed provider
context and is accessed only by Performer backend implementations.

## 12. Security and observability

- Provider SDK packages must be absent from Conductor and Podium dependencies.
- Import-boundary tests scan production source and dependency manifests.
- Environment allowlists exclude Podium, Linear, browser-session, proxy, and
  unrelated secret variables.
- Performer validates provider responses as untrusted input before use.
- Config-source reads are bounded, decoded, sanitized, and path-free inside the
  backend implementation.
- Logs use stable generic events such as
  `performer_control_started`, `performer_backend_invoked`,
  `performer_control_completed`, and `performer_check_failed`.
- Correlation includes runtime/conductor, run/work item/turn, request,
  operation, process, lease, and fencing ids when available.
- Secret redaction keeps the error category and next action visible.
- Every terminal backend failure has parity across logs, durable state, and
  relevant Podium/Linear surfaces.

## 13. Required tests

### Shared contracts

- exact control request/result discriminators and strict unknown-field rejection;
- capability versioning and unsupported-operation errors;
- generic readiness/error serialization with no provider SDK values;
- secret/path/oversize rejection.

### Performer

- backend interface contract suite against CodexBackend and a test backend;
- explicit registry accepts only approved kinds;
- Codex SDK login/logout/account/config/Check behavior remains inside Performer;
- logical `api_base_url` maps to the typed Codex app-server call;
- execution policy maps to every Codex thread/turn parameter;
- provider exceptions and payloads normalize to generic sanitized results;
- secret control input uses pipes and creates no persisted request/result file;
- device-login handle stays inside the control subprocess;
- control protocol emits bounded valid events/results.

### Conductor

- no provider SDK dependency/import/provider-generated type;
- fake Performer control process exercises status/login/config/Check;
- generic lane is asynchronous and returns `performer_busy` while occupied;
- fixed environment is immutable and allowlisted;
- startup readiness reset and policy-hash compatibility;
- non-ready block and exact-phase resume;
- error visibility parity across SQLite/log/report/Linear projections.

### Podium and Web

- provider-neutral operations/routes only;
- owner-only, no-store relay with fencing, timeout, duplicate, and stale reply checks;
- capability-driven rendering and unsupported-control hiding;
- no SDK/raw path/Base64/secret fields in normalized replies;
- API-key/device/config transient-state and cache-clearing tests;
- mutations do not start Check.

### Package boundary

- `performer_api` imports no role package;
- Conductor/Podium import neither Performer nor provider SDKs;
- provider SDK imports are restricted to Performer backend implementation modules.

## 14. Real E2E

The Performer diagnostic and final real flow use one staged per-batch backend
context. They never reference or copy directly from ambient `~/.codex`.

The run must prove:

- status/capabilities are obtained through installed `performer control`;
- login/config control, when exercised, is processed by Performer and leaves no
  secret-bearing control file;
- manual Check is invoked through installed Performer and gates turns;
- real plan/execute/gate all run through the same installed Performer boundary;
- Conductor has no provider SDK dependency at runtime;
- stale fencing and duplicate results remain safe;
- readiness failures appear immediately in state, logs, reports, and Linear;
- logs and artifacts contain no secrets or private provider paths;
- OAuth, Linear, Performer, and Overall reports share one final run id.

## 15. Scope ledger

### Authorized

- Performer-owned backend interface and explicit closed registry.
- Conductor depending only on `performer_api` and installed Performer processes.
- Generic control/capability/readiness contracts and Podium surfaces.
- Codex as the first concrete production backend.

### Required consequences

- Remove `CodexController`, provider SDK imports, provider handles, and provider
  config parsing from Conductor implementation plans.
- Rename Codex-specific control state, operations, routes, UI, and errors to
  Performer-level vocabulary.
- Preserve policy-only profiles, fixed context, no-store control, manual Check,
  and durable visible readiness failures.

### Out of scope

- A production Claude adapter without a separately approved SDK/auth/config spec.
- Dynamic plugins or backend marketplace.
- Multiple backends in one managed run or scheduler selection among backends.
- Compatibility shims for the superseded controller/slot architecture.

### Assumptions requiring approval

- None.

### Deferred ideas

- Separately specified ClaudeBackend.
- Additional logical editable settings after an approved product need.
