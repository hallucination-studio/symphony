# Module baseline: `performer`

Status: proposed baseline, 2026-07-11.

## Responsibility

Performer is a local, single-turn Codex worker. Conductor starts the installed
`performer` command with a request-file path and a result-file path. Performer
loads one validated request, runs exactly one `plan`, `execute`, or `gate` turn,
and writes one structured result. It never owns workflow state, Linear access,
Podium authentication, scheduling, or repository selection.

## Target surface

```text
performer/
  __init__.py
  cli.py          # request file -> one turn -> result file
  config.py       # staged Codex configuration and secret-safe summary
  codex.py        # direct pinned SDK client
  backend.py      # plan, execute, gate prompts and parsing
  schemas.py      # the three output schemas
```

The pinned `openai-codex` client is used directly through its canonical async
turn API after a real SDK proof. The compatibility adapter, maybe-await layer,
continuation provider, generic backend registry, and unused worker/title
options are not carried forward.

## Turn behavior

| Turn | Input | Output | Side effects |
|---|---|---|---|
| `plan` | Parent issue context and repository context | Ordered `Plan` | No file edits |
| `execute` | One child task and acceptance criteria | `ExecuteResult` | Codex may edit the bound repository |
| `gate` | One completed task and its evidence | Boolean `GateResult` | Read-only inspection only |

The request includes the exact `TurnContext`, prompt, staged runtime location,
and output schema. The result includes the same context, a bounded summary,
structured evidence, and a sanitized failure or runtime wait when applicable.

## Runtime guarantees retained

- Each invocation gets an isolated per-role `CODEX_HOME` staged from an
  approved seed; the process never falls back to the operator's home directory.
- The fencing token is checked before the process starts and before the result
  is accepted. A stale result is recorded and ignored.
- SDK events, stdout, and stderr are captured with run/task/attempt correlation.
- Retryable overload, timeout, malformed structured output, and runtime waits
  preserve the latest sanitized reason and retry metadata.
- Missing configuration, SDK failure, invalid JSON, and process exit are
  operator-visible errors, not silent generic failures.

## Explicit removals

Remove synthetic runtime-wait injection, continuation/multi-turn policy,
`max_turns`, unused worker-host/title arguments, default text schemas,
role/backend capability registries, and the split helper/event/runtime files
that only forward calls. Keep actual Codex approval/tool-input waits; removing
those would change the product behavior.

Performer must not open HTTP/WebSocket connections or import Conductor/Podium.

## Migration and exit gate

1. Add process-level contract tests for all three turn kinds, invalid context,
   runtime waits, timeout, and secret isolation.
2. Replace the current client composition with the five target owners.
3. Prove request/result paths, direct SDK initialization, event capture, and
   result fencing with a staged runtime home.
4. Delete old adapter/helper/runtime modules and old options from CLI help.

The baseline is complete when one invocation maps to one request and one result,
the only turn kinds are `plan|execute|gate`, no compatibility module remains,
and a new engineer can trace the entire process from `cli.py` to `codex.py`
without crossing a registry or continuation abstraction.
