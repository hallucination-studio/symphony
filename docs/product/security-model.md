# Security model

## Credential boundary

Podium is the only product role that stores Linear application credentials and
workspace installation access/refresh tokens. It encrypts customer-owned
application secrets and installation tokens at rest, refreshes them server
side, and injects them only into outbound Linear proxy requests.

Browser and Conductor responses never contain Linear access or refresh tokens,
session-cookie values, passwords, client secrets, raw provider credentials, or
Authorization headers. Conductor has a scoped Podium runtime credential and a
scoped proxy credential, not a direct Linear token.

## OAuth and polling

OAuth state is one-time, time-bounded, workspace-bound, and PKCE-protected.
Podium accepts only an app actor with the required scopes and a verified Linear
organization/app user. Polling is project- and installation-scoped, fully
cursor-paginated, durable, and fail-closed when token refresh or live blocker
checks fail.

## Runtime enrollment and proxy

Enrollment tokens are one-time, short-lived, and stored hashed. A runtime
report refreshes the HTTP presence TTL used by Web; there is no WebSocket or
persisted runtime-group routing system. `runtime_group_id` is a deterministic
display alias only.

Every Conductor Linear operation travels through Podium's authenticated proxy.
Podium resolves the runtime to its active project binding and installation,
enforces the project/organization boundary, logs a sanitized audit result, and
does not fall back to a deployment-wide Linear token.

## Local Performer and provider isolation

Podium owns only secret-free Symphony execution/turn policy, profile ids,
binding generation, and hashes. One Conductor selects one fixed allowlisted
backend process context and starts installed Performer control/turn processes.
It imports only `performer_api` and does not import a provider SDK, parse
provider files, or hold provider login/session handles.

Performer backend implementations are the only modules allowed to import
provider SDKs or generated provider types and to perform provider
authentication, configuration, Check, or turn mapping. Provider responses are
untrusted until validated and normalized inside that boundary.

Secret-bearing controls use stdin/stdout pipes or an equivalent in-memory
channel. API keys, device secrets, credentials, provider config paths, and raw
SDK payloads never enter persisted control files, Conductor SQLite, Podium
PostgreSQL/runtime commands, browser caches/responses, Linear comments, logs,
or managed-run reports.

Production reuses the fixed provider-owned context and does not create
per-attempt credential/config copies. The real-E2E harness may stage one
isolated per-batch context from an approved fixed seed and must reject direct
ambient `~/.codex` inputs. Missing or invalid backend setup fails closed with a
generic actionable reason plus a bounded sanitized adapter summary.

The harness copies only `config.toml`, `auth.json`, `version.json`, and
`models_cache.json` when present, requires the authentication/config seed
baseline, passes the temporary context only through the installed process
environment, and deletes it after the Performer phase. Reports contain only
presence, hashes, normalized results, and sanitized artifact paths, never the
staged context path or file contents.

## Error visibility

Security-sensitive failures fail closed but remain observable through the
relevant durable state, sanitized API/view, and correlated operator log. Error
visibility must preserve category and next action without exposing secret
values.
