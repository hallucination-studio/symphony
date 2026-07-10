# Linear Integration

## Purpose

Podium is the only managed component that directly integrates with Linear.
Conductor and Performer use Podium's scoped proxy and projection APIs; Linear
OAuth access and refresh tokens never leave Podium.

## Application Selection

Podium provides one default Linear OAuth application from deployment
configuration. An operator may instead stage a customer-owned application with
its client id, client secret, and webhook signing secret. The default and custom
paths produce the same installation record and use the same callback,
validation, project, webhook, reconciliation, proxy, and dispatch logic.

The callback and webhook URLs belong to Podium and are fixed for an
installation:

```text
https://<podium-host>/api/v1/linear/oauth/callback
https://<podium-host>/api/v1/linear/webhooks
```

A custom application must register those URLs. Podium does not accept an
operator-supplied callback URL. Client secrets and webhook signing secrets are
encrypted at rest and never returned to the browser.

## OAuth Installation

Authorization uses `actor=app`, `prompt=consent`, and the minimum required
scopes, including `read`, `write`, `app:assignable`, and `app:mentionable`.
Linear installs the app actor into the workspace; this is not a project-level
OAuth installation.

Podium stores an application configuration version in each one-time OAuth
state. The callback rejects expired, consumed, unknown, or configuration-stale
state. Token exchange always uses the exact application configuration that
started the authorization.

Every callback creates or updates a candidate installation and runs acceptance
before the installation can serve traffic. Acceptance verifies:

- a valid access token and refresh metadata;
- `actor=app` and all required scopes;
- `viewer.app=true` and `supportsAgentSessions=true`;
- the real Linear organization id, URL key, and display name;
- the workspace-specific app user id returned by `viewer { id }`;
- project discovery and access to every already-selected project;
- sanitized, durable success or failure evidence.

A failed candidate never replaces the active installation. A successful fresh
installation becomes active. A successful replacement waits for Managed Runs
and dispatches to drain, prepares every bound Conductor with the new app user
id, then switches atomically. The old token remains active until that cutover
finishes and is retired afterward.

## Project Scope

After authorization, Podium lists projects visible to the installation. The
operator may select multiple projects that Symphony is allowed to manage.
Podium stores stable Linear project ids as authority and caches slug and name
for display.

Project selection does not mutate `ProjectUpdateInput.memberIds`. Workspace and
team access granted by Linear remain the permission boundary. Podium verifies
that each selected project is readable and writable, then records its own
project scope and health.

Each selected project may have at most one active Conductor. Each Conductor may
bind exactly one selected project and one repository mapping. The project
binding, not a Linear label, is routing truth. Multiple independent Conductors
may run on the same host when their service identities, data roots, ports,
credentials, and logs are isolated.

When a binding is ready, Podium adds one operator-visible project label:

```text
symphony:conductor/Beethoven-k7m3p2
```

The name is a workspace-unique, case-insensitive ASCII word of at most 16
characters. The operator may provide it or let Podium allocate an unused
historical musician surname; exhausted names receive the shortest available
numeric suffix. The six-character public id is immutable and non-secret.
Renaming replaces the managed label idempotently. Labels are never dispatch
filters.

## Delegated Issue Intake

AgentSession webhooks are the low-latency intake path. Podium verifies the HMAC
over the raw body, checks the timestamp window, deduplicates `Linear-Delivery`,
matches the organization and app installation, normalizes the event, and
applies project routing.

Installation- and project-scoped reconciliation polling is the durability
fallback. It uses the installation token and durable cursors, continues in a
visible degraded state while webhook delivery is unhealthy, and returns to the
healthy webhook path when signed deliveries resume. Webhook and reconciliation
events share one durable dispatch idempotency key, so the same AgentSession or
delegated issue can queue only once.

Normalized intake includes:

```json
{
  "event_type": "linear.delegated_issue",
  "linear_organization_id": "linear-organization-id",
  "linear_project_id": "linear-project-id",
  "project_slug": "project-slug",
  "app_user_id": "workspace-app-user-id",
  "issue_id": "linear-issue-id",
  "issue_identifier": "AI-149",
  "agent_session_id": "linear-agent-session-id"
}
```

## Routing And Proxy

Podium routes only when the active installation, selected project, project
binding, Conductor, repository, app user, issue state, blockers, and runtime
capacity all match. Human assignee and project labels are excluded from routing
truth.

Managed runtimes call:

```text
POST https://<podium-host>/api/v1/linear/graphql
Authorization: Bearer <runtime-proxy-token>
```

Podium resolves the proxy token through the Conductor's single project binding
to the active workspace installation. It injects that installation's OAuth
token server-side and enforces organization, project, operation, audit, rate
limit, refresh, and redaction policy. There is no global application-id/token
fallback.

## Health And Verification

Installation health distinguishes callback validation, webhook readiness,
degraded reconciliation, draining, switching, ready, failed, and retired
states. Failures preserve `error_code`, sanitized reason, retryability,
`action_required`, timestamps, and `next_action` in durable state, APIs, logs,
and Podium Web.

Acceptance evidence must show application source and config version, callback
validation, organization and app user ids, project access, signed webhook
delivery, reconciliation cursor behavior, duplicate suppression, single-project
Conductor binding, repository mapping, project label, proxy authorization,
dispatch, cutover behavior, and absence of secrets from browser responses,
runtime files, logs, and artifacts.
