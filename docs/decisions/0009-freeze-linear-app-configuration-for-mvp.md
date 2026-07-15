# ADR-0009: Freeze Linear app configuration for the MVP

## Status

Accepted by the user on 2026-07-15.

This ADR refines ADR-0007's fixed-app decision and supersedes the application
version, candidate, cutover, and replacement portions of ADR-0001. It does not
change polling, project routing, Managed Run plan revisions, binding
generations, process desired revisions, or SQLite schema migrations.

## Context

The MVP ships one fixed public Linear app. A manifest/config revision field
would imply supported changes: detecting a mismatch, choosing which version is
active, migrating an installation, reauthorizing, cutting over credentials,
and defining compatibility. None of those customer or runtime behaviors is
required for the MVP.

Keeping the field without the lifecycle would create a misleading interface
and untestable branches. Implementing the lifecycle would expand the approved
scope.

## Decision

The MVP has exactly one fixed Linear app configuration containing:

- public client id;
- fixed loopback callback;
- `actor=app`;
- exact `read`, `write`, and `app:assignable` scopes.

There is no `manifest_revision`, `application_config_revision`, configuration
version, candidate configuration, cutover, compatibility branch, or app-config
migration. The required `LINEAR_CLIENT_ID` process environment supplies the
release-owned public client id; UI and SQLite cannot override or mutate it,
and callback, actor, and scopes remain code-owned. Installation records do not
persist a configuration revision.

The installed Python package and Desktop bundle must contain the same exact
fixed non-client-id resource. A missing client-id environment value, missing
resource, or unexpected field/value fails closed. A
future need to change the client id, callback, actor, or scopes requires a new
product decision and design; the MVP does not pre-build that path.

## Consequences

- The manifest contract and installation schema are smaller.
- OAuth readiness validates the fixed identity and exact scopes, not a stored
  configuration version.
- Tests prove one exact bundled configuration and reject overrides or unknown
  fields; they do not test revision mismatch or migration.
- Normal application updates that do not change the fixed Linear app continue
  to reuse `podium.db` credentials as defined by ADR-0008.

## Rejected alternatives

### Keep an unused revision field

Rejected because an observable field becomes a contract even when no complete
modification lifecycle exists.

### Implement app configuration changes now

Rejected because candidate installs, credential cutover, compatibility,
reauthorization, and rollback are outside the MVP.
