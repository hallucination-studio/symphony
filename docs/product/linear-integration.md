# Linear Integration

## Purpose

Podium is the only managed component that directly integrates with Linear as an
OAuth application. Conductor and Performer use Podium's scoped proxy and
projection APIs.

## Application Ownership

Symphony operates one official Linear application. Customers authorize that app
from Podium; they do not create their own Linear app for the managed path.

The app owns:

- OAuth callback at `https://<podium-host>/api/v1/linear/oauth/callback`;
- minimum scopes for issues, comments, states, project/team reads, and agent
  session workflows;
- application id and app actor token used for delegated issue intake.

OAuth access and refresh tokens are encrypted at rest in Podium.

## OAuth Flow

1. The user clicks Connect Linear in Podium.
2. Podium creates an install attempt with signed state.
3. The browser redirects to Linear authorization.
4. The user approves the Symphony app.
5. Linear redirects to Podium with code and state.
6. Podium validates state and exchanges the code.
7. Podium stores the workspace installation.
8. Podium fetches workspace, teams, projects, states, labels, and app user id.
9. Podium marks the workspace connected and starts health checks.

Stored installation state includes workspace id, organization URL key, scopes,
token expiry, app user id, creating user, timestamps, and sanitized health.

## Delegated Issue Intake

A managed work item starts when the Linear issue is delegated to the Symphony
custom agent. Podium receives or discovers the delegated issue, normalizes it to
a dispatch event, records cursor/error state, and applies routing.

First-version normalized event:

```json
{
  "event_type": "linear.delegated_issue",
  "workspace_id": "linear-workspace-id",
  "project_slug": "project-slug",
  "issue_id": "linear-issue-id",
  "issue_identifier": "AI-149",
  "agent_session_id": "linear-agent-session-id"
}
```

Intake errors keep sanitized durable state: last success, cursor, error code,
sanitized reason, retryability, and next action.

## Routing

A routing rule maps Linear work to runtime capacity by:

- Linear workspace;
- project/team scope;
- custom-agent delegate id;
- issue active states;
- repository mapping;
- runtime group;
- concurrency limits;
- enabled/disabled state.

Labels and human assignee are not managed dispatch routing truth.

## GraphQL Proxy

Managed runtimes call:

```text
POST https://<podium-host>/api/v1/linear/graphql
Authorization: Bearer <runtime-proxy-token>
```

Podium resolves the proxy token to runtime, account, workspace installation,
project/team scope, and audit policy, then sends the GraphQL request to Linear
with the stored OAuth token.

The proxy enforces runtime auth, allowed workspace, allowed project/team,
optional operation policy, token refresh, audit logging, rate limits, and secret
redaction.

## Development Mode

Loopback Podium is acceptable for local development and acceptance when OAuth
redirect settings allow it. The managed architecture still assumes deployed
Podium has stable HTTPS endpoints and customer runtimes use outbound
connectivity.

## Verification

Acceptance evidence must show connected workspace health, delegated issue intake,
cursor/error visibility, routing decision, queued dispatch, proxy authorization,
and absence of Linear OAuth tokens from runtime config, browser responses, logs,
and artifacts.
