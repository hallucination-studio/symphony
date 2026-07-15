# Security model

## Credential boundary

Podium is the only product role that stores or uses Linear installation
access/refresh tokens. In the accepted Desktop target, the fixed public app has
no client secret and the token pair is stored as plaintext fields in the
installation row of Podium-owned `podium.db`. Symphony does not add an OS
credential-store adapter, application encryption, key management, ciphertext,
or a memory-only fallback. This is a deliberate local single-user simplicity
trade-off recorded in ADR-0008.

Podium refreshes and replaces the pair in one SQLite transaction and injects
the access token only into outbound Linear requests. Normal restart and
application update reuse the same database. A missing, unreadable, or corrupt
database fails closed; after restore or reset, any lost credential requires
authorization again. Failure does not trigger a second credential store or
automatic migration.

Browser, Tauri, and Conductor responses never contain Linear access or refresh
tokens, session-cookie values, passwords, client secrets, raw provider
credentials, or Authorization headers. Conductor has no direct Linear token;
it requests only allowlisted project-scoped operations through the private
Podium boundary.

## OAuth and polling

OAuth state is one-time, time-bounded, workspace-bound, and PKCE-protected.
Podium accepts only an app actor with the required scopes and a verified Linear
organization/app user. Polling is project- and installation-scoped, fully
cursor-paginated, durable, and fail-closed when token refresh or live blocker
checks fail.

## Private runtime boundary and Linear gateway

The Desktop target has no runtime enrollment token, public runtime HTTP
listener, bearer, cookie, or shared secret. Desktop creates a private channel
for each expected Podium/Conductor child; the session is bound to process
identity, instance, project, binding generation, and fencing metadata through
closed `performer_api` contracts.

Every Conductor Linear operation travels through Podium's allowlisted local
gateway. Podium resolves the Conductor to its active project binding and
installation, enforces the project/organization boundary, logs a sanitized
audit result, injects the Linear access token internally, and does not fall
back to another token source.

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
runtime commands, browser caches/responses, Linear comments, logs, or
managed-run reports.

Production reuses the fixed provider-owned context and does not create
per-attempt credential/config copies. The real-E2E harness may stage one
isolated per-batch context from an approved fixed seed and must reject direct
ambient `~/.codex` inputs. Missing or invalid backend setup fails closed with a
generic actionable reason plus a bounded sanitized adapter summary.

The harness copies only `config.toml`, `auth.json`, `version.json`, and
`models_cache.json` when present, requires the authentication/config seed
baseline, passes the temporary context only through the installed process
environment, and deletes it after the Performer phase. Reports contain only
provider-neutral policy hashes, normalized results, and sanitized artifact
paths; they never contain seed/auth/config content hashes, the staged context
path, or file contents.

## Error visibility

Security-sensitive failures fail closed but remain observable through the
relevant durable state, sanitized API/view, and correlated operator log. Error
visibility must preserve category and next action without exposing secret
values.
