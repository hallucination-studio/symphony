# Security model

## Credential boundary

Podium is the only product role that stores Linear application credentials and
workspace installation access/refresh tokens. It encrypts customer-owned
application secrets and installation tokens at rest, refreshes them server
side, and injects them only into outbound Linear proxy requests.

Browser and Conductor responses never contain Linear access or refresh tokens,
session-cookie values, passwords, client secrets, raw Codex credentials, or
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

## Local Codex isolation

Conductor stages an isolated `CODEX_HOME` per managed turn and captures
sanitized Performer output. Secret configuration uses `$VAR` indirection;
values are validated but not returned in reports, Linear comments, or logs.
Missing or invalid setup fails visibly with a sanitized actionable reason.

## Error visibility

Security-sensitive failures fail closed but remain observable through the
relevant durable state, sanitized API/view, and correlated operator log. Error
visibility must preserve category and next action without exposing secret
values.
