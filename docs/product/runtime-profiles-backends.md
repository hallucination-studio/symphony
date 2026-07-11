# Codex runtime

Performer is Codex-only. Runtime configuration carries a version and policy
revision for plan, execute, and gate turns. Any role-labelled profile keys in a
Podium response are sanitized presentation data; they are not a backend
registry or scheduling decision.

## Isolation

Conductor stages an approved seed into an isolated per-attempt `CODEX_HOME`.
Only `config.toml`, `auth.json`, `version.json`, and `models_cache.json` may be
copied. The default user home is rejected. A seed is supplied through a fixed
environment variable and never printed in a report or log.

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
