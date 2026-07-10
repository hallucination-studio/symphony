# ADR-0001: Unified Linear Installations And Single-Project Conductors

## Status

Accepted

## Date

2026-07-10

## Context

The existing design mixed two unrelated credential paths. Podium could build an
OAuth URL from either deployment credentials or customer-provided credentials,
but delegated issue intake still depended on one global application id and app
actor token. Project selection was onboarding metadata only, and Conductor
project bindings appeared later through runtime reports. As a result, a custom
application did not actually replace the default application after OAuth, and a
successful onboarding flow did not establish a routable project runtime.

Linear's current agent model installs an app actor at workspace scope with
`actor=app`. The installed app has a workspace-specific app user id. Linear does
not expose a separate project-application authorization mutation. The
`app:assignable` scope permits delegation and project membership, but Symphony
does not need to mutate project members to define its routing scope.

Official references:

- https://linear.app/developers/oauth-actor-authorization
- https://linear.app/developers/oauth-2-0-authentication
- https://linear.app/developers/agents
- https://linear.app/developers/webhooks

## Decision

Podium owns one active Linear installation per Podium workspace. Deployment
credentials provide the default application. A customer may stage a custom
application, but both sources enter one versioned OAuth installation lifecycle.
Every callback validates actor, scopes, app identity, organization identity,
project access, and token metadata before activation.

AgentSession webhooks are the immediate intake path. Installation- and
project-scoped reconciliation polling continuously covers missed deliveries and
keeps the product operational with explicit degraded health when webhook
delivery is unavailable. Both paths share durable cursors and dispatch
idempotency.

Project selection is Podium authorization state, not a Linear project-member
mutation. Each selected project has one repository mapping and at most one
active Conductor. Each Conductor binds exactly one project. Multiple independent
Conductors may run on the same host through isolated service identities, data
roots, ports, credentials, and logs.

The project displays `symphony:conductor/<Name>-<public-id>`. The name is a
workspace-unique single English word chosen by the operator or allocated from a
historical musician surname list. The public id is short, immutable, and
non-secret. The label is operator context only and never routing truth.

Application replacement is staged. The active installation continues serving
until the candidate passes acceptance, current Managed Runs drain, and all
project Conductors acknowledge the new app identity. Podium then switches the
installation generation atomically and retires the previous token.

## Alternatives Considered

### Keep A Global App Actor Token For Intake

Rejected because it creates split-brain behavior: OAuth and proxy traffic may
use a customer application while intake still observes the default application.
It also prevents per-workspace token health and clean application replacement.

### Install Or Authorize The App Separately For Every Project

Rejected because Linear's app actor installation is workspace scoped and the
public API has no project-application authorization mutation. Project access is
validated against the active installation and constrained in Podium.

### Add The App User To Every Selected Project

Rejected as a default behavior. `projectUpdate(memberIds)` is a general project
membership mutation, not the authorization mechanism. Symphony must not rewrite
customer project membership merely to establish its own routing scope.

### Let One Conductor Serve Multiple Projects

Rejected for this product version. It reduces process count but couples project
repositories, credentials, labels, queues, capacity, and failure domains. A
single-project Conductor makes routing and rollback auditable and allows strict
one-project ownership.

### Block When Webhooks Are Unhealthy

Rejected because webhook delivery is an external dependency that can fail
temporarily. Durable reconciliation preserves work intake while making the
degraded state and required webhook repair visible.

## Consequences

- The deployment-global application-id and app-actor-token path is removed.
- Custom application setup requires Podium's fixed callback and webhook URLs
  plus a webhook signing secret.
- OAuth state must bind an immutable application configuration version.
- Real Linear organization, project, and app user ids become first-class
  routing identifiers; Podium account ids cannot stand in for them.
- Conductor enrollment and project assignment become separate steps.
- Repository mapping moves from workspace scope to project binding scope.
- Same-host multi-project operation uses multiple isolated Conductors.
- Project labels become additive, idempotent operator metadata.
- Tests and real acceptance must prove both webhook delivery and polling
  recovery without duplicate dispatches.
