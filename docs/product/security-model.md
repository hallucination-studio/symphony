# Security Model

## Primary Boundary

Podium is the trust boundary for third-party integrations. It holds Linear OAuth
tokens and exposes the public HTTPS endpoints required by Linear.

Customer runtimes are trusted to execute code in the customer's environment, but
they should not receive Linear OAuth access or refresh tokens.

## Token Ownership

### Podium-held secrets

- Linear OAuth access token
- Linear OAuth refresh token
- Linear webhook signing secret
- runtime enrollment token hashes
- runtime credential material
- Linear proxy token mapping

### Runtime-held secrets

- runtime identity credential
- scoped dispatch/proxy credential
- customer-local execution secrets explicitly configured by the customer

Runtime-held credentials should be revocable from Podium and scoped to one
account/runtime group.

## Linear Proxy Rules

Every Linear request from Conductor or Performer goes through Podium.

Podium should enforce:

- runtime authentication
- workspace authorization
- routing scope
- project/team restrictions
- operation auditing
- rate limiting
- secret redaction

The proxy should not log raw Linear OAuth tokens, refresh tokens, or runtime
proxy tokens.

## Runtime Enrollment

Runtime enrollment tokens should be:

- short-lived
- single-use where possible
- bound to a customer account
- optionally bound to runtime group and install profile
- stored hashed on Podium

After enrollment, Podium issues runtime credentials and invalidates the
enrollment token.

## Webhook Verification

Podium must verify every Linear webhook signature before parsing it as a trusted
event.

Invalid signatures and malformed JSON should be rejected before dispatch.

## Update Security

Runtime packages should be distributed with:

- version metadata
- checksum
- signature
- rollback metadata

The updater should verify artifacts before switching versions.

## Operational Safety

Podium Web should provide:

- revoke Linear workspace connection
- rotate runtime tokens
- disable routing rule
- disable runtime
- force runtime update
- view recent dispatch and proxy audit logs

Destructive actions should be explicit and auditable.

## First-Version Acceptable Risk

The first managed version may use bearer runtime tokens and HTTPS transport
instead of mTLS, as long as tokens are scoped, revocable, and never printed in
logs.

The managed path does not use direct `LINEAR_API_KEY` runtime credentials.
Linear tokens are held by Podium and exposed to customer runtimes only through
scoped proxy tokens.
