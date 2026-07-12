# Codex runtime

Performer is Codex-only. Podium owns one binding-scoped, versioned non-secret
`config.toml` and policy revision for plan, execute, and gate turns. Podium
delivers it as an idempotent `runtime.config.apply` command over the existing
authenticated runtime polling transport. Reports and Web views expose only the
config version, SHA-256, policy revision, and sanitized credential readiness.

This is a configuration document, not a backend/profile registry. It never
contains `auth.json`, API keys, ChatGPT access tokens, keyring exports, or
credential-bearing environment values.

## Isolation

Conductor materializes the accepted Podium config and a local credential source
into an isolated per-attempt `CODEX_HOME`. Only `config.toml`, `auth.json`,
`version.json`, and `models_cache.json` may be copied from a fixed staged seed;
the default user home is rejected. The seed is supplied through an explicit
local configuration and never printed in a report or log.

Official `codex login` with ChatGPT OAuth is supported without an API token. The
real-flow path uses a dedicated locally staged Codex home (and its approved
`auth.json` when file-backed) and never reads the operator's ambient `~/.codex`.
Codex owns login refresh; credentials remain local and are not uploaded to
Podium.

Missing or inaccessible local auth fails closed with a concrete sanitized
reason such as `managed_codex_auth_required`, while an invalid Podium config
fails with `managed_codex_config_invalid`.

Every request/result carries `run_id`, `task_id` when applicable, `attempt_id`,
`fencing_token`, and `turn_kind`. Performer echoes the exact context; Conductor
rejects stale or mismatched results before changing durable state.

## Turn permissions

- `plan` returns an ordered `Plan` and may not change files.
- `execute` changes only the declared task file scope.
- `gate` is read-only and returns one `GateResult`.

The gate receives command evidence and the changed-file summary. A mutation or
invalid structured result fails closed with a sanitized reason. Backend events,
stdout, and stderr are captured in the attempt log with correlation ids.

## Failure behavior

Missing seed files, Codex startup failures, malformed JSON, timeouts, and stale
fences are durable failures with `error_code`, `sanitized_reason`,
`action_required`, `retryable`, and `next_action`. They appear in SQLite, the
Conductor log, the relevant Linear issue, and the Podium report without secrets.
