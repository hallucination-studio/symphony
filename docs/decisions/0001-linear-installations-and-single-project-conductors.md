# ADR-0001: Unified Linear Installations And Single-Project Conductors

## Status

Accepted

## Date

2026-07-10

## Context

The earlier design mixed deployment and customer credential paths. OAuth could
start with either application, but delegated issue intake still depended on a
global app identity. Project selection was onboarding metadata rather than
routing authority, so a customer application did not fully replace the default
application and onboarding did not produce a uniquely routable runtime.

Linear installs an app actor at workspace scope with `actor=app` and gives it a
workspace-specific app user id. Linear exposes no separate project-application
authorization mutation. The `app:assignable` scope permits delegation, while
Symphony does not need to rewrite project membership to establish routing scope.

Official references:

- https://linear.app/developers/oauth-actor-authorization
- https://linear.app/developers/oauth-2-0-authentication
- https://linear.app/developers/agents

## Decision

Podium owns one active Linear installation per Podium workspace. Deployment
credentials provide the default application; a customer may instead provide a
client id and client secret. Both enter one versioned OAuth lifecycle using
Podium's fixed callback, `actor=app`, `read write app:assignable`, short-lived
one-time state, PKCE, and identical acceptance.

The callback records denied consent and returns to `/setup/linear`. Acceptance
validates token metadata, exact scopes, app-capable viewer, organization,
workspace app user, and fully paginated project access. The first valid install
activates immediately. Same-identity reauthorization rotates credentials
without draining. A different app identity in the same organization uses a
candidate, drain, Conductor acknowledgement, atomic switch, and retirement. An
organization change requires explicit reset or migration.

All Linear access goes through a central installation-token service. It refreshes
proactively, serializes refresh per installation, atomically stores rotating
refresh credentials, retries once after `401`, exposes reauthorization-required
state, and revokes disconnected or retired credentials. Managed traffic never
uses a human or deployment-global access token.

Reliable installation- and project-scoped polling is the sole delegated-issue
intake. Project discovery, baseline issue discovery, and incremental scans use
full cursor pagination. Durable observations, idempotent dispatch rows, and page
checkpoints commit transactionally; a stable update-time/issue-id order and
boundary overlap prevent skips. Repeated observations reuse one delegation
epoch, and only an observed delegation transition can open a later epoch.

Project selection is Podium routing state, not a Linear project-member mutation.
Each selected project has one repository mapping and at most one active
Conductor. Each Conductor binds exactly one project. Multiple independent
Conductors may run on one host through isolated identities, data roots, ports,
credentials, and logs.

The project displays `symphony:conductor/<Name>-<public-id>` as operator context.
The label is additive and idempotent; it never authorizes or routes work.

## Alternatives Considered

### Keep A Global App Actor Token

Rejected because OAuth and proxy traffic could use a customer application while
intake still observed the default identity. It also prevents workspace-specific
token health, refresh, revocation, and clean application replacement.

### Install Or Authorize The App Separately For Every Project

Rejected because Linear's app actor installation is workspace scoped and the
public API has no project-application authorization mutation. Podium validates
project access and constrains routing after OAuth.

### Add The App User To Every Selected Project

Rejected because `projectUpdate(memberIds)` is a general membership mutation,
not application authorization. Symphony must not rewrite customer project
membership merely to define its own routing scope.

### Use Multiple Intake Paths

Rejected because two independently delivered representations require identity
normalization and deduplication while still leaving polling necessary for
durability. One reliable polling state machine has a single checkpoint,
idempotency, retry, and evidence model.

### Let One Conductor Serve Multiple Projects

Rejected for this product version. It couples repositories, credentials, labels,
queues, capacity, and failure domains. A single-project Conductor keeps routing,
rollback, and ownership auditable.

## Consequences

- Customer application setup needs only client id, client secret, and Podium's
  fixed callback URL.
- OAuth state binds the Podium workspace and immutable application config
  version; callback and refresh failures are durable operator-visible states.
- Organization, project, app user, installation generation, and delegation epoch
  are first-class routing and idempotency identifiers.
- Every list and issue scan must paginate to completion and commit resumable
  checkpoints before advancing its high-water mark.
- Conductor enrollment and project assignment remain separate steps; repository
  mapping belongs to the one-project binding.
- Project labels remain operator metadata only.
- Tests and real acceptance must prove callback return behavior, token rotation,
  polling completeness, crash recovery, deduplication, redelegation, cutover,
  and visible failure state.
