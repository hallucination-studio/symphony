# ADR-0006: Performer owns the backend interface and provider integrations

## Status

Accepted by the user on 2026-07-13.

This ADR supersedes ADR-0005 only where ADR-0005 assigns provider SDK,
authentication, configuration, Check execution, or provider session-handle
ownership to Conductor. It retains ADR-0005's one-context, no-store, manual
Check, fixed-environment, and policy-only profile decisions, but moves their
implementation behind Performer.

ADR-0004 remains authoritative only for separate mutable `runtime_profiles`,
`performer_profiles`, and `performer_bindings` without profile revision tables.

## Context

ADR-0005 correctly removed Codex credentials and configuration documents from
Podium, but it placed `openai-codex`, `AsyncCodex`, app-server requests, login
handles, and Check execution in Conductor. That violates Symphony's runtime
boundary:

- Conductor is the durable workflow orchestrator and local process manager.
- Performer is the execution role that hides backend/tool implementation
  details.
- Conductor and Performer may share contracts through `performer_api`, but
  must not import each other's packages.

The phrase "one Conductor uses one Codex context" described deployment scope,
but was incorrectly treated as code ownership. A fixed context can be selected
and process-managed by Conductor while all provider-specific behavior remains
inside Performer.

Symphony must also be able to host a closed set of backend implementations
without teaching Conductor about Codex, Claude, or any future provider SDK.

## Decision

Symphony uses two interface layers:

```text
performer_api
  dependency-free, closed wire contracts
  ├── managed turn request/result
  ├── control request/result
  ├── capabilities
  └── readiness and sanitized errors

performer
  internal PerformerBackend interface
  ├── CodexBackend
  ├── ClaudeBackend (future, separately specified)
  └── test backends
```

Conductor imports only `performer_api`. It invokes the installed `performer`
command and never imports `performer`, a provider SDK, or provider-generated
types.

Performer owns:

- the internal `PerformerBackend` Protocol or ABC;
- the explicit, closed backend factory registry;
- provider SDK imports and generated types;
- provider login/logout/account behavior;
- provider configuration read/write behavior;
- readiness Check execution;
- mapping Symphony execution policy to provider SDK calls;
- provider response validation, error classification, and sanitization.

Conductor owns:

- selection of one configured backend context for its process lifetime;
- the fixed allowlisted environment passed to Performer processes;
- generic control/turn subprocess lifecycle and cancellation;
- one generic control lane that serializes conflicting control and turn work;
- durable `performer_control_state` and managed-run readiness gating;
- durable workflow state, fencing, retries, logs, and operator projection.

Podium owns authenticated relay and operator UI only. It persists Symphony
profile and binding facts, but no provider account, credential, configuration
source, local path, or readiness result.

## Internal backend interface

The Performer-owned interface is intentionally small. Its semantic shape is:

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

The exact Python method layout may use an ABC or split control and turn
helpers, but these invariants are fixed:

1. Conductor never sees this Python interface; it sees only `performer_api`
   wire contracts.
2. Provider-specific request/response types never cross the Performer package
   boundary.
3. Capability differences are explicit data, not `hasattr`, exception-message
   parsing, or provider conditionals in Conductor/Podium.
4. Backend selection uses an explicit closed registry in Performer. The MVP
   does not load arbitrary plugins, entry points, or user code.
5. An unsupported operation returns the closed
   `performer_operation_not_supported` error with capability evidence.

Codex is the first production implementation. A production Claude adapter and
its authentication/configuration contract require a separate approved design;
this ADR does not guess those SDK details or ship a placeholder integration.

## Shared wire contracts

Contracts needed by more than one role live in `performer_api` and remain
provider-neutral:

- `PerformerTurnRequest` / `PerformerTurnResult` retain the existing fenced
  plan, execute, and gate semantics.
- `PerformerControlRequest` is a closed discriminated union for status, login,
  session deletion, config read, config write, and Check.
- `PerformerControlResult` is a closed discriminated union with normalized,
  sanitized operation results.
- `PerformerCapabilities` declares supported login methods, editable logical
  settings, config-source visibility, Check support, and turn kinds.
- `PerformerReadinessState` uses generic states such as `unchecked`, `checking`,
  `ready`, and `failed`.
- `PerformerControlError` carries `error_code`, `sanitized_reason`,
  `action_required`, `retryable`, and `next_action`.

Provider-neutral logical fields are mapped inside the adapter. For example,
the shared setting `api_base_url` may map to Codex's `openai_base_url`; neither
Conductor nor Podium performs that mapping.

Capabilities are closed and versioned. They describe differences between
known backends without turning Symphony into a dynamic plugin marketplace or
a scheduler that switches backends within one managed run.

## Process boundary and secret transport

Managed turns may continue to use fenced request/result JSON files because
those contracts are secret-free and require durable result collection.

Secret-bearing control operations must not use persisted request/result files.
They use stdin/stdout or an equivalent pipe owned by the Performer subprocess.
The closed control request carries only metadata plus the declared secret-input
kind/length; the value follows as a separate bounded length-delimited stdin
frame and is passed to the backend as `secret_input`:

```text
Podium request memory
  -> Conductor relay memory
    -> performer control metadata frame + secret-input frame
      -> backend SDK call
    <- normalized control stdout/events
```

Device-code login may require a long-running `performer control` process. The
provider login handle and SDK session remain inside that process. Conductor
holds only a generic subprocess handle, consumes normalized events, and may
cancel by closing or terminating the subprocess. A Conductor restart loses the
live login process and projects a generic `lost` login state; it never tries to
reconstruct a provider SDK handle.

Control stdout is a bounded structured protocol. Performer stdout/stderr logs
remain correlated and sanitized; secret input, raw SDK objects, local config
paths, Base64 file contents, and authorization material must never be logged or
returned.

## One context and concurrency

One Conductor still selects one backend kind and one fixed backend process
context for its lifetime. All control and turn processes receive the same
allowlisted `HOME`, optional provider home variables, and approved binary path.
Symphony runtime policy arrives through the closed control/turn contracts, not
environment overrides. Symphony production code does not copy, parse, or write
provider credential stores.

Conductor serializes mutually exclusive work through one generic Performer
lane. This prevents a login/config mutation or Check from racing a managed
turn. The lane protects subprocess lifecycle, not a provider SDK object.

The lane must be asynchronous: waiting for a Performer subprocess must not
block Conductor's event loop, dispatch heartbeats, lease heartbeats, status
requests, or cancellation handling.

## Readiness

Readiness is a Performer-level contract, not a Codex-specific Conductor model.

Conductor persists one secret-free `performer_control_state` row containing:

- backend kind and capability version;
- current readiness status;
- last Check outcome and timestamps;
- closed error code and sanitized reason;
- action required, retryability, and next action;
- the execution-policy hash checked by the last successful Check.

Startup resets current readiness to `unchecked` while retaining the previous
sanitized outcome as evidence. Login, logout, and configuration mutations
return an `unchecked` readiness state before a new turn may begin. A successful
manual Check is the only transition to `ready`.

Conductor gates plan, execute, and gate turns using this generic state. A
non-ready run blocks visibly in SQLite, structured logs, Podium managed-runs,
and Linear, and resumes its exact prior workflow phase only after a compatible
Check succeeds.

Generic error names include:

- `performer_check_required`;
- `performer_login_required`;
- `performer_busy`;
- `performer_operation_not_supported`;
- `performer_backend_setup_failed`;
- `performer_control_protocol_invalid`.

Provider-specific detail may appear only as a bounded sanitized summary from
Performer, never as a provider exception type or raw payload.

## Podium API and UI

Live operations use provider-neutral names:

```text
performer.status
performer.login
performer.session.delete
performer.config.read
performer.config.write
performer.check
```

The BFF routes are rooted at a Conductor's `performer` resource, not a Codex
resource. Podium authorizes and relays these operations, validates the closed
wire result, applies no-store response headers, and never persists live control
payloads.

The Runtimes UI is capability-driven. It may display the selected backend's
human label and the controls declared by `PerformerCapabilities`, but it does
not contain SDK calls, provider response parsing, or hard-coded assumptions
that every backend supports device login, API keys, source config, or Base URL
editing.

## Security and error visibility

- Provider credentials and SDK objects exist only inside Performer backend
  implementations and their subprocess memory/provider-owned store.
- Conductor and Podium never import provider SDKs or generated provider types.
- API keys, device secrets, tokens, raw config paths, and credential files are
  never persisted in Podium or Conductor state.
- Third-party responses are untrusted and validated inside the owning backend
  implementation before normalization.
- Every failure is sanitized but remains visible with a stable category,
  action, retryability, and correlation identifiers.
- A terminal control or turn failure must have parity across Performer logs,
  Conductor durable state, and the relevant Podium/Linear surface.

## Testing consequences

Tests must prove:

1. package boundaries reject provider SDK imports outside Performer backend
   implementation modules;
2. Conductor can exercise control and turn flows using only `performer_api`
   contracts and a fake Performer process;
3. the Performer backend contract has at least a production Codex adapter and
   test adapter coverage through the same contract suite;
4. the explicit registry selects only approved backend kinds and fails closed
   for unknown kinds;
5. unsupported capabilities fail with a closed generic error;
6. secret-bearing controls use pipes and leave no request/result artifacts;
7. device-login provider handles never enter Conductor state;
8. readiness block/resume and error visibility remain durable and correlated;
9. Codex policy/login/config/Check/turn SDK details are tested inside Performer;
10. real E2E invokes both Check and plan/execute/gate through the installed
    `performer` command.

## Consequences

Benefits:

- Conductor remains stable when provider SDKs or generated types change.
- Backend-specific complexity has one owner and one sanitization boundary.
- Additional approved backends can implement the same Performer contract.
- Podium and Conductor stay capability-driven without becoming plugin hosts.
- Secret-bearing login/config operations no longer require durable files.

Tradeoffs:

- Performer needs a second control-mode protocol in addition to fenced turns.
- Long-running device login requires subprocess event and cancellation handling.
- Capabilities and normalized errors become shared versioned contracts.
- A real second provider still needs its own approved adapter design and tests.

## Scope ledger

### Authorized

- A provider-neutral Performer boundary consumed by Conductor through
  `performer_api`.
- A Performer-owned interface with multiple possible implementations.
- Codex as the first concrete production backend.
- Generic control, capabilities, readiness, and error contracts.
- Correction of ADR-0005 and the active implementation plan.

### Required consequences

- Move all provider SDK/config/auth/Check ownership out of Conductor plans.
- Replace `CodexController`, `codex_control_state`, and `performer_codex.*`
  architecture with generic Performer subprocess/control concepts.
- Preserve ADR-0005's no-store, one-context, manual Check, fixed-environment,
  and policy-only profile outcomes.

### Out of scope

- Implementing or selecting a production Claude SDK/auth/config contract.
- Dynamic backend plugins, entry points, or a provider marketplace.
- Switching backend within one managed run or adding a multi-backend scheduler.
- Production code cleanup in this document-only correction step.

### Assumptions requiring approval

- None for the corrected boundary.

### Deferred ideas

- A separately approved Claude backend implementation.
- Additional provider-neutral editable settings after concrete use cases exist.
