# Security Model

## Primary Boundary

Podium is the trust boundary for third-party integrations. It holds Linear OAuth
tokens, serves public HTTPS endpoints, authenticates users and runtimes, and
turns privileged integration access into scoped runtime operations.

Customer runtimes are trusted to execute code in the customer's environment, but
they do not receive Linear OAuth access or refresh tokens.

## Token Ownership

Podium-held secrets:

- Linear OAuth access and refresh tokens;
- Linear app actor token and application id;
- runtime enrollment token hashes;
- runtime identity credentials;
- dispatch and proxy token mappings;
- update signing and channel metadata.

Runtime-held secrets:

- runtime identity credential;
- scoped dispatch/proxy credential;
- customer-local execution secrets explicitly configured for attempts;
- staged per-mode backend homes, such as managed `CODEX_HOME` copies.

Runtime-held credentials are scoped to one account/runtime group and revocable
from Podium.

## Linear Proxy Rules

Every managed Linear request from Conductor or Performer goes through Podium:

```text
POST /api/v1/linear/graphql
Authorization: Bearer <runtime-proxy-token>
```

Podium resolves the proxy token to the runtime, account, Linear workspace
installation, project/team scope, and audit policy. It injects the stored Linear
OAuth token only into the outbound request to Linear.

The proxy enforces runtime authentication, workspace authorization, project/team
scope, operation auditing, rate limits, token refresh, and secret redaction. It
must not log raw OAuth tokens, refresh tokens, cookies, passwords,
Authorization headers, runtime profile secrets, or proxy token values.

## Enrollment Safety

Runtime enrollment tokens are short-lived, single-use where possible, bound to a
customer account, and optionally bound to runtime group, OS/architecture, and
install profile. Podium stores enrollment token hashes, not raw reusable tokens.

After enrollment, Podium returns scoped runtime credentials and invalidates the
enrollment token. Re-enrollment and token rotation are explicit operator
actions.

## Runtime Configuration

Secrets flow through `$VAR` indirection in runtime profiles. Podium and
Conductor validate that required variables exist without rendering secret values
in browser responses, logs, reports, or attempt JSON.

Managed mode fails closed when a required per-mode profile, backend home, or
credential materialization step is missing. It must not fall back to the
operator's global `~/.codex`.

## Update Security

Runtime packages are distributed with version metadata, checksums, signatures,
rollback metadata, and an assigned channel. The updater verifies artifacts before
switching versions. The previous version remains available until the new version
passes health checks.

## Operator Controls

Podium Web exposes actions to revoke a Linear workspace connection, rotate
runtime tokens, disable routing, disable a runtime, force an update, and inspect
recent dispatch/proxy audit logs. Destructive actions are explicit and auditable.

## Acceptable First-Version Risk

Bearer runtime tokens over HTTPS are acceptable for the first managed version
when they are scoped, revocable, sanitized from logs, and never exposed to the
browser as raw credentials. mTLS can strengthen runtime identity later without
changing the authority boundary.
