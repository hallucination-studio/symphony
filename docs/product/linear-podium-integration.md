# Linear Application and Podium Integration

## Goal

Podium should be the only component that directly integrates with Linear as an
OAuth application. Conductor and Performer should access Linear through Podium's
controlled proxy.

## Linear Application Ownership

Symphony should create and operate an official Linear OAuth application:

- Name: Symphony or Symphony Podium
- OAuth callback: `https://<podium-host>/api/v1/linear/oauth/callback`
- OAuth scopes: minimum required read/write scopes for issue reads, comments,
  labels, state transitions, and agent session workflows

The application is created once by Symphony. Customers install it into their
Linear workspace through OAuth authorization.

## OAuth Install Flow

1. User clicks **Connect Linear** in Podium.
2. Podium creates an install attempt with a signed `state`.
3. Browser redirects to Linear OAuth authorize URL.
4. User approves the Symphony Linear application.
5. Linear redirects to Podium callback with `code` and `state`.
6. Podium validates `state`.
7. Podium exchanges `code` for access and refresh tokens.
8. Podium stores the workspace installation.
9. Podium fetches workspace, projects, teams, labels, and user context.
10. Podium marks the Linear workspace as connected.

Stored installation fields:

- `installation_id`
- `linear_workspace_id`
- `linear_organization_url_key`
- `access_token`
- `refresh_token`
- `expires_at`
- `scope`
- `app_user_id`
- `created_by_user_id`
- `created_at`
- `updated_at`

Access and refresh tokens must be encrypted at rest.

## Delegate Polling Flow

1. A Linear issue is delegated to the Symphony custom agent.
2. Podium polls Linear with `PODIUM_LINEAR_APPLICATION_ID` and
   `PODIUM_LINEAR_APP_ACCESS_TOKEN`.
3. Podium normalizes matching delegated issues into Symphony dispatch events.
4. Podium records the per-binding poll cursor and last sanitized error in the
   durable store.
5. Podium finds matching routing rules by workspace, project, delegate, and
   available runtimes.
6. Podium enqueues the dispatch.
7. An online Conductor receives or pulls the dispatch.

First-version normalized event:

```json
{
  "event_type": "linear.delegated_issue.polled",
  "workspace_id": "linear-workspace-id",
  "project_slug": "project-slug",
  "issue_id": "linear-issue-id",
  "issue_identifier": "AI-149",
  "agent_session_id": ""
}
```

## Linear GraphQL Proxy

Performer and Conductor use:

```text
POST https://<podium-host>/api/v1/linear/graphql
Authorization: Bearer <runtime-proxy-token>
```

Podium resolves the proxy token to:

- runtime
- customer account
- Linear workspace installation
- allowed project/team scope

Podium then sends the GraphQL request to Linear with the stored OAuth access
token.

The proxy should enforce:

- valid runtime token
- allowed workspace
- allowed project/team
- optional operation allowlist or audit policy
- request/response logging with secret redaction
- token refresh before expiry

## Routing Model

A routing rule maps Linear work to runtime capacity:

- Linear workspace
- project or team
- Linear custom agent delegate
- issue states
- repository mapping
- runtime group
- concurrency limits

Example:

```json
{
  "workspace_id": "linear-workspace-id",
  "project_slug": "d17d2f7a038d",
  "linear_agent_app_user_id": "linear-app-user-id",
  "runtime_group": "default",
  "repo_mapping_id": "repo-123"
}
```

## Development Mode

For local development, Podium can run on `127.0.0.1` and the OAuth callback can
use a loopback HTTP redirect URI. Linear OAuth redirect URIs allow absolute HTTP
or HTTPS URLs.

Delegate polling works from loopback development environments because Podium
initiates outbound GraphQL requests to Linear. A public HTTPS URL is still
required for OAuth redirect URIs in deployed environments, but local acceptance
does not require an inbound Linear event tunnel.
