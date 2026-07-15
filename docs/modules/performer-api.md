# Module target: `performer-api`

Status: ADR-0006 boundary implemented and locally verified on 2026-07-13;
external real-flow acceptance remains tracked in `tasks/plan.md`.

## Responsibility

`performer-api` is the dependency-free shared wire-contract package. It
contains only closed JSON models needed across role/process boundaries:

- ordered plans, tasks, revisions, and acceptance evidence;
- fenced turn request/result context;
- execution and turn policy;
- provider-neutral Performer control request/event/result contracts;
- capabilities, readiness, and sanitized control errors.
- private local runtime handshake/envelope identity used across role boundaries.

It does not execute work, select or load a backend implementation, persist
state, call Linear, make HTTP requests, import a provider SDK, or contain SDK
objects/generated provider types.

~~~text
performer-api <- performer
performer-api <- conductor
performer-api <- podium, only when a shared contract is needed
~~~

## Target surface

~~~text
performer_api/
  labels.py
  workflow.py
  turns.py or performer_turns.py
  runtime_policy.py
  performer_control.py
  local_runtime.py
  validation.py
~~~

Codex-named shared policy modules are removed after callers migrate; no
compatibility alias remains.

## Contracts

- `RuntimePolicy` and `PerformerProfileConfig` contain only Symphony policy,
  binding identity, and canonical hashes.
- `PerformerTurnRequest` / `PerformerTurnResult` carry strict fencing and
  normalized plan/execute/gate data.
- `PerformerControlRequest`, events, and results are closed discriminated
  unions for status, login, session deletion, config read/write, and Check.
  They contain metadata only; an optional secret value uses a separate bounded
  stdin frame and never becomes a serializable result/request field.
- `PerformerCapabilities` describes backend kind/display label, supported
  logical login/config/Check operations, turn kinds, and protocol version.
- `PerformerReadinessState` is provider-neutral and bound to backend,
  binding, capability, and policy identity.
- `PerformerControlError` preserves stable category, sanitized reason,
  action, retryability, attempt number where applicable, and next action.
- `LocalRuntimeHandshake` and `LocalRuntimeEnvelope` are closed, secret-free
  identity contracts for private inherited IPC. They define no transport,
  persistence, Linear behavior, or domain payload.

Logical settings such as `api_base_url` are mapped to provider configuration
inside Performer. No shared contract exposes provider config keys, JSON-RPC,
filesystem operations, paths, raw SDK payloads, or secrets.

## Boundary rules

- Validate untrusted JSON at every process/HTTP boundary.
- Reject unknown discriminators/fields, oversized data, secret-like fields,
  local paths, Base64 blobs, and provider-generated shapes.
- Conductor must be able to construct and validate every control/turn exchange
  using only this package.
- Backend Python interfaces and registries belong in `performer`, not here.
- The package has no scheduler, dynamic plugin loader, provider marketplace, or
  compatibility aliases.
