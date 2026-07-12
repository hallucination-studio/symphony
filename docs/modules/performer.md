# Module baseline: `performer`

Status: implemented code baseline, 2026-07-12. The pinned SDK path is covered
with a local source-shape test; it has not been exercised against a real Codex
account in this repository run.

## Responsibility

Performer is the local, single-turn Codex worker. Conductor starts the installed
`performer` command with request/result paths. Performer validates one request,
runs exactly one `plan`, `execute`, or `gate` turn, and writes one structured
result with the exact fenced context.

It owns neither workflow state, Linear access, Podium authentication,
scheduling, nor repository selection. It may make the network connection needed
by the Codex SDK, but it must not directly access Linear/Podium or their
credentials.

## Current surface

```text
performer/
  __init__.py
  cli.py                   # request file -> one result file
  backend.py               # plan/execute/gate prompts and result parsing
  codex_client.py          # direct SDK lifecycle, stream, retry, event capture
  codex_client_helpers.py  # parsing, exception classification, close/env helpers
  codex_config.py          # safe staged Codex configuration
  schemas.py               # plan, execute, and gate JSON schemas
```

`codex_client.py` uses the pinned `openai-codex==0.1.0b3` async
`thread.turn(..., output_schema=...)` API. It reads the final JSON from the
SDK's notification stream and preserves notification payloads used for runtime
approval/tool-input waits. The one-use runtime mixin has been inlined; the
configuration and helper boundaries remain because they own different concerns.

## Turn behavior

| Turn | Input | Output | Side effects |
|---|---|---|---|
| `plan` | Parent issue context and repository | Ordered `Plan` | No file edits |
| `execute` | One Sub Issue task | `ExecuteResult` | Codex may edit the bound repository |
| `gate` | Completed task and command evidence | `GateResult` | Read-only inspection |

## Runtime guarantees

- Each invocation uses an isolated staged `CODEX_HOME`; it never falls back to
  the operator's home directory.
- The context/fencing token is checked before process start and result
  acceptance. Stale results are visible and ignored.
- SDK events plus stdout/stderr are captured with run/task/attempt correlation.
- Retryable overload, timeout, malformed JSON, and genuine Codex runtime waits
  retain a sanitized reason and visible event trail.
- Performer does not synthesize runtime waits, continuation policies, generic
  default text schemas, or a backend registry.
