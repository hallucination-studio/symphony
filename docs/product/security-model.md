# Security Model

## Primary Boundary

Podium is the trust boundary for third-party integrations. It holds Linear
application credentials and workspace installation tokens, serves public HTTPS
endpoints, authenticates users and runtimes, and turns privileged integration
access into project-scoped runtime operations.

Customer runtimes execute code in the customer's environment but never receive
Linear OAuth access tokens, refresh tokens, or client secrets.

## Linear Secret Ownership

Deployment configuration provides the default application's client id, client
secret, and fixed callback URL. A customer-owned application stores only its
client id and encrypted client secret as a versioned configuration in Podium;
the callback remains Podium-owned. There is no deployment-global app actor
access token used for intake or proxy fallback.

Every authorized workspace has its own encrypted installation access and
refresh token, real Linear organization id, workspace-specific app user id,
scope set, configuration version, and health state. A candidate installation
cannot replace the active installation until acceptance and drain gates pass.

Browser responses may show non-secret client ids, the callback URL, organization
metadata, app user ids, scopes, health, timestamps, and sanitized errors. They
never include secret values.

## OAuth And Callback Safety

OAuth uses hashed one-time state with a short expiry, Podium workspace binding,
application config id/version, and `S256` PKCE. The callback rejects replay or
configuration drift and validates the token response as untrusted input.

Acceptance requires an app actor, the exact `read write app:assignable` scopes,
an app-capable viewer, real organization identity, workspace-specific app user
id, and fully paginated project access. Failed candidates retain durable
diagnostics and cannot affect the active installation. Callback success and
denial both return to the setup surface without exposing credentials.

## Polling And Token Safety

Polling is the only delegated-issue intake and is installation- and
project-scoped. Baseline and incremental scans paginate to completion. Issue
observations, delegation epochs, idempotency rows, dispatches, and page
checkpoints commit transactionally before the high-water mark advances.

The central token service serializes refresh per installation, rotates access
and refresh tokens atomically, refreshes proactively, and retries once after an
authenticated `401`. Refresh rejection fails closed as
`reauthorization_required`. Poll failures retain the last safe checkpoint,
retry count, sanitized reason, and bounded backoff state for operators.

## Project And Runtime Scope

Podium stores selected Linear project ids and verifies access without rewriting
project members. Each project has at most one active Conductor and each
Conductor has one project, repository, runtime group, and proxy credential.
Database uniqueness and transactional reservation enforce the one-to-one
binding.

The six-character Conductor public id is non-secret. The project label contains
only the workspace-unique display name and public id. Labels never authorize or
route work.

## Linear Proxy Rules

Every managed Linear request from Conductor or Performer goes through Podium:

```text
POST /api/v1/linear/graphql
Authorization: Bearer <runtime-proxy-token>
```

Podium resolves the proxy token through the Conductor's project binding to the
active Linear installation. It injects that installation token server-side and
enforces organization, project, operation, audit, rate limit, refresh, and
redaction policy. It never falls back to an environment access token.

## Enrollment And Runtime Secrets

Enrollment tokens are short-lived, single-use, account- and Conductor-scoped,
and stored hashed. After enrollment, each isolated Conductor holds only its
runtime identity credential, scoped proxy credential, and customer-local
execution secrets. Same-host Conductors use separate data roots and service
identities.

Runtime profile secrets use `$VAR` indirection. Podium and Conductor validate
required variables without rendering values in browser responses, logs,
reports, or turn JSON. Managed execution fails closed rather than falling back
to global operator credentials such as `~/.codex`.

## Operator Controls

Podium exposes staged application replacement, reconnect, revoke, project
select/deselect, Conductor bind/unbind/replace, runtime token rotation, routing
disable, update, and audit-log actions. Destructive actions are explicit,
drain-aware, and auditable.

## Acceptable First-Version Risk

Scoped bearer runtime tokens over HTTPS are acceptable when revocable and
sanitized from logs. OAuth client secrets remain shared secrets; later
key-managed signing or mTLS can strengthen runtime boundaries without changing
the installation and project authority model.
