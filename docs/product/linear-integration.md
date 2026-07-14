# Linear Integration

## Purpose

Podium is the only managed component that directly integrates with Linear.
Conductor and Performer use Podium's scoped proxy and projection APIs; Linear
OAuth access and refresh tokens never leave Podium.

## Application Selection

Podium provides one default Linear OAuth application from deployment
configuration. An operator may instead stage a customer-owned application with
only its client id and client secret. Both sources enter one versioned OAuth
installation lifecycle and use the same acceptance, project, polling, proxy,
dispatch, refresh, and retirement logic.

Podium owns the callback URL:

```text
https://<podium-host>/api/v1/linear/oauth/callback
```

A customer-owned application must register that URL. Podium does not accept an
operator-supplied callback URL. Client secrets are encrypted at rest, treated as
write-only, and never returned to the browser. Podium exposes no separate
inbound Linear event endpoint.

## OAuth Installation

Authorization uses `actor=app` and `prompt=consent`; the exact required scopes
are `read`, `write`, and `app:assignable`. Linear installs one app actor at
workspace scope. Project selection is a later Podium routing decision, not a
project-level OAuth installation.

Podium creates a hashed, one-time, short-lived OAuth state bound to the Podium
workspace and immutable application config id and version.
Authorization uses `S256` PKCE. The callback rejects expired, consumed, unknown,
or configuration-stale state, and token exchange uses the exact config version
that started authorization.

The callback handles success and denied consent as durable, sanitized outcomes.
It always returns `303 See Other` to `/setup/linear`; the setup page reads the
outcome from Podium rather than displaying tokens or a standalone callback page.

Every successful exchange runs acceptance before serving traffic. It verifies:

- a valid access token and refresh metadata;
- the app actor and exact required scope set;
- `viewer.app=true`;
- the real Linear organization id, URL key, and display name;
- the workspace-specific app user id returned by the viewer query;
- fully paginated project discovery and access to every selected project;
- sanitized, durable success or failure evidence.

First installation activates immediately. Reauthorization with the same
application, organization, and app-user identity atomically rotates credentials
without draining or changing installation generation. Different app identity in
the same organization remains a candidate while Podium drains Managed Runs and
dispatches, prepares every bound Conductor with the candidate app user id, and
switches atomically before retiring the old credentials. Different Linear
organization identity is rejected until an operator performs an explicit reset
or migration. A failed candidate never replaces the active installation.

Reauthorization does not disconnect the current installation first. The
replacement must retain access to every actively bound project; inaccessible
unbound selections are reviewed after activation. An operator may disconnect
and revoke an installation only after active project bindings and managed work
are cleared. Successful disconnect deactivates the installation and clears its
selected projects. Revocation failure remains durable and visible with an
idempotent Retry revocation action rather than being reported as disconnected.

## Token Lifecycle

Linear access tokens expire after 24 hours and refresh tokens rotate. A central
token service supplies credentials for project discovery, polling, proxy, and
acceptance calls. It performs proactive refresh under a per-installation
single-flight lock, atomically persists the new access token and rotated refresh
token, and permits one refresh-and-retry after a Linear `401`.

An invalid or rejected refresh marks the installation
`reauthorization_required`, stops new managed traffic, and exposes a sanitized
action in durable health, APIs, logs, and Podium Web. Podium revokes credentials
on disconnect or retirement; a failed revocation remains visible for retry.
There is no global application-id/token fallback.

## Project Scope

After authorization, Podium lists projects visible to the installation. Project
discovery follows `pageInfo.hasNextPage` and `endCursor` and never truncates a
workspace at a fixed first page. The operator may select multiple projects that
Symphony is allowed to manage; stable Linear project ids are authoritative and
slug and name are display metadata.

Project selection does not mutate `ProjectUpdateInput.memberIds`. Workspace and
team access granted by Linear remain the permission boundary. Podium verifies
that each selected project is readable and writable, then records routing scope
and health.

Project selection is independent from authorization. Adding another accessible
project through Integrations does not repeat OAuth or disturb existing bindings;
it reopens only its missing Conductor, binding, and smoke readiness work. An
unbound project may be deselected directly; a bound project must be unbound
first.

Each selected project may have at most one active Conductor. Each Conductor may
bind exactly one selected project and one repository mapping. The project
binding, not a Linear label, is routing truth. Multiple independent Conductors
may run on the same host when identities, data roots, ports, credentials, and
logs are isolated.

When a binding is ready, Podium adds
`symphony:conductor/<Name>-<six-character-public-id>` as operator metadata. Names
are workspace-unique, case-insensitive ASCII words of at most 16 characters;
the public id is immutable and non-secret. Rename is idempotent. Labels are
never dispatch filters.

## Delegated Issue Intake

Reliable polling is the only delegated-issue intake path. Each new binding runs
a full baseline scan of currently delegated root issues before incremental
polling begins; it does not use a short lookback window. Incremental scans
include delegated and no-longer-delegated issues updated in the selected project
so ownership transitions cannot disappear from state.

Every scan uses full cursor pagination. Podium follows Linear `pageInfo`, sorts
the durable processing order by `(updatedAt, issue_id)`, and overlaps the last
timestamp boundary so equal timestamps cannot skip an issue. In one database
transaction, each page persists issue observations, delegation state,
idempotency records, queued dispatches, and its transactional page checkpoint.
The high-water mark advances only after the final page commits. A crash resumes
from the last committed page without losing or duplicating work.

Repeated observations belong to one continuously observed delegation epoch and
reuse its dispatch idempotency key. Podium closes that epoch only after a
durably observed non-delegated transition. A later delegation starts a new epoch,
allowing exactly one dispatch per delegation epoch. Every epoch for the same
Linear issue still commits or resumes that issue's one durable Managed Run.
Parent/projection issues are excluded before dispatch.

Poll failures retain the last safe checkpoint, error code, sanitized reason,
retry count, and next attempt. The scheduler uses durable exponential backoff
with jitter and a bounded retry interval; success clears degraded health. No
error path advances a checkpoint or waits indefinitely without operator-visible
state.

## Routing And Proxy

Podium routes only when the active installation, selected project, project
binding, Conductor, repository, app user, issue state, blockers, and runtime
active state and blockers all match. Human assignee and project labels are excluded from routing
truth.

Managed runtimes call `POST /api/v1/linear/graphql` with a runtime proxy token.
Podium resolves it through the Conductor's single project binding, obtains a
fresh active-installation token through the central token service, and enforces
organization, project, operation, audit, rate-limit, and redaction policy.

## Health And Verification

Installation health distinguishes authorization, ready, refreshing,
reauthorization-required, draining, switching, failed, disconnected, and retired
states. Polling health records baseline/incremental mode, page checkpoint,
high-water mark, last success, retry count, and sanitized error.

Acceptance evidence must show application source/config version, callback and
denial behavior, organization/app user identity, token rotation, project
pagination and access, baseline/incremental checkpoint behavior, delegation
idempotency, single-project Conductor binding, repository mapping, project label,
proxy authorization, dispatch, cutover behavior, and absence of secrets from
browser responses, runtime files, logs, and artifacts.
