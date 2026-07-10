# Security Model

## Primary Boundary

Podium is the trust boundary for third-party integrations. It holds Linear
application credentials and workspace installation tokens, serves public HTTPS
endpoints, authenticates users and runtimes, and turns privileged integration
access into project-scoped runtime operations.

Customer runtimes execute code in the customer's environment but never receive
Linear OAuth access tokens, refresh tokens, client secrets, or webhook signing
secrets.

## Linear Secret Ownership

Deployment configuration provides the default application's client id, client
secret, fixed callback URL, and webhook signing secret. A customer-owned
application stores the same fields as an encrypted versioned configuration in
Podium. There is no deployment-global app actor access token used for intake or
proxy fallback.

Every authorized workspace has its own encrypted installation access and
refresh token, real Linear organization id, workspace-specific app user id,
scope set, configuration version, and health state. A candidate installation
cannot replace the active installation until acceptance and drain gates pass.

Browser responses may show non-secret client ids, callback/webhook URLs,
organization metadata, app user ids, scopes, health, timestamps, and sanitized
errors. They never include secret values.

## OAuth And Callback Safety

OAuth uses one-time state with expiry, consumption, application config id, and
config version. The callback rejects state replay or configuration drift and
validates the token response as untrusted input.

Acceptance requires an app actor, required scopes, app-capable viewer, Agent
Session support, real organization identity, workspace-specific app user id,
and project access. Failed candidates retain durable diagnostics and cannot
affect the active installation.

## Webhook Safety

Podium verifies `Linear-Signature` over the raw body using HMAC-SHA256 and the
matching application signing secret. It validates the Linear timestamp within a
bounded replay window and deduplicates `Linear-Delivery` before processing.
Organization or application ids parsed before signature verification are only
lookup hints and are never trusted until a secret validates the request.

Webhook and reconciliation intake use the same durable event identity.
Polling is installation- and project-scoped and may not use a human token or a
global app token. Degraded webhook health, poll failures, retry counts, and
last cursors are durable and operator visible.

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
sanitized from logs. HMAC webhook secrets and OAuth client secrets remain
shared secrets; later key-managed signing or mTLS can strengthen these
boundaries without changing the installation and project authority model.
