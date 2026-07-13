# Module target: `performer`

Status: ADR-0006 target boundary accepted on 2026-07-13; implementation is
tracked in `tasks/plan.md`.

## Responsibility

Performer is the local execution worker and provider boundary. Conductor starts
the installed `performer` command for:

- one fenced `plan`, `execute`, or `gate` turn; or
- provider-neutral control over a bounded stdin/stdout protocol.

Performer owns the internal backend interface, explicit closed registry,
provider SDKs, provider login/config/Check behavior, policy-to-SDK mapping,
third-party response validation, error classification, and sanitization.

It owns neither durable workflow state, Linear access, Podium authentication,
scheduling, repository selection, nor operator projection.

## Target shape

~~~text
performer/
  cli.py
  managed_turn.py
  control_host.py
  backend_interface.py
  backend_registry.py
  backends/
    codex.py
  schemas.py
~~~

Codex helper modules may remain split where they have clear SDK-owned
responsibilities, but every provider SDK import and generated provider type
must stay under Performer-owned backend implementation modules.

## Backend contract

`PerformerBackend` is a private Protocol or ABC with capability, control, and
turn behavior. The explicit registry maps approved `performer_kind` values to
factories. It does not load arbitrary plugins, entry points, or user code.

CodexBackend is the first production implementation. A deterministic fake
backend exercises the same contract in tests. A production ClaudeBackend
requires a separately approved SDK/auth/config design.

Performer core owns Symphony prompts, schemas, workspace-change rules, wire
validation, runtime-wait normalization, and final result framing. Backend
implementations hide provider SDK/CLI differences.

## Turn behavior

| Turn | Input | Output | Side effects |
|---|---|---|---|
| `plan` | Parent issue context and repository | Ordered `Plan` | No file edits |
| `execute` | One Sub Issue task | `ExecuteResult` | Backend may edit the bound repository |
| `gate` | Completed task and command evidence | `GateResult` | Read-only inspection |

## Control behavior

The long-running control host uses a closed metadata frame plus an optional
length-delimited stdin secret frame and closed stdout events/results. Provider
login handles stay inside the process. API keys and similar secrets exist only
in secret-frame/backend-call memory and never in argv, environment, files,
stdout, stderr, logs, or result payloads.

Status/cancel remain available while device login is pending. Login/config
mutations return readiness `unchecked`; only an explicit structured Check may
return `ready`.

## Runtime guarantees

- The registry fails closed for unknown backend kinds.
- Provider responses are untrusted until validated and normalized.
- Fencing is checked before turn start and result acceptance.
- SDK events/stdout/stderr are captured with correlation and redaction.
- Provider errors never cross as raw exceptions, paths, or payloads.
- Performer does not own workflow resume, durable readiness, Linear, or Podium.
