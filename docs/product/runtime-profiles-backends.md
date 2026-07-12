# Codex runtime

Performer is the Symphony-owned agent layer. A `performer_profile` selects the
agent/SDK kind, turn policy, one immutable `runtime_profile` revision, and one
local credential reference. Codex is the first runtime adapter; future SDK
agents use the same Performer wrapper without changing project bindings.
Podium delivers the selected runtime revision through the existing idempotent
`project.configure` command over authenticated runtime polling. Reports and Web
views expose only ids, revision/hash, policy revision, and sanitized credential
readiness.

Performer/runtime profiles are reusable configuration metadata, not a backend
scheduler or generic plugin registry. They never contain `auth.json`, API keys,
ChatGPT access tokens, keyring exports, or credential-bearing environment
values.

## Isolation

Conductor materializes the selected immutable Podium config revision and the
selected local credential slot into an isolated per-attempt `CODEX_HOME`. Only
`config.toml`, `auth.json`, `version.json`, and `models_cache.json` may be
copied from a fixed staged slot; the default user home is rejected. Slot paths
and credentials are local-only and never printed in a report or log.

Official `codex login` with ChatGPT OAuth is supported without an API token by
running it in the selected local credential slot. Multiple OAuth accounts and
API-key slots are independent records; Codex owns login refresh inside the
selected slot. Credentials remain local and are not uploaded to Podium.

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
