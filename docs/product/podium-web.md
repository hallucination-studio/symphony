# Podium Web

## Purpose

Podium Web guides an operator from an empty account to a working Linear-powered
runtime, then shows Managed Runs health without exposing secrets or requiring
the operator to understand internal process boundaries.

The UI is served by Podium's BFF/static host. Browser responses never include
Linear access tokens, refresh tokens, runtime credentials, session cookies,
passwords, client secrets, or raw profile secrets.

## Onboarding

### Connect Linear

The first setup step starts OAuth, validates callback state, shows the connected
workspace, lists teams/projects, confirms app scopes, and displays installation
health.

### Select Scope

The operator chooses the Linear project/team, active states, terminal states,
custom-agent delegate, and routing rule. Podium defaults to narrow scope and
makes broad workspace access explicit.

### Map Repository

Repository mapping connects a routed Linear project to a runtime workspace. The
first version supports a local runtime path or Git URL. Future hosted workspace
providers must preserve the same runtime-profile and token boundaries.

### Install Runtime

Podium creates a short-lived enrollment token and displays an install command
with target runtime group, expiry, OS/architecture expectation, and live
enrollment status. After Conductor enrolls, the page shows runtime id, version,
hostname, channel, last heartbeat, and workspace roots.

### Smoke Check

The smoke check verifies runtime connectivity, Linear proxy access, runtime
config validity, routing readiness, and optional Linear read/write access. It
does not require Codex to make source changes.

## Main Surfaces

Integrations:

- Linear workspace status and scopes;
- token refresh health;
- delegated issue intake health;
- reconnect and revoke actions.

Runtimes:

- runtime list and online/offline state;
- version, update channel, and host metadata;
- runtime groups and enrollment commands;
- last heartbeat and staged config version.

Routing:

- project/team/delegate filters;
- repository mapping;
- runtime group assignment;
- capacity limits;
- enabled/disabled state.

Managed Runs:

- parent runs and work items;
- active policy, capacity, and runtime profiles;
- backend thread ids and latest turn state;
- verification results, checkpoint results, and file impact;
- blocked work items, human approval waits, and runtime waits;
- Linear projection links and sanitized errors.

## Error Surfaces

Failures become operator actions:

- OAuth failure -> reconnect Linear;
- delegated issue intake failure -> inspect app id, app actor token, and route;
- runtime offline -> restart or reinstall runtime;
- stale runtime -> update or change channel;
- proxy denied -> rotate/re-enroll runtime credentials;
- repository unavailable -> fix repository mapping;
- profile materialization failure -> fix runtime profile secrets;
- graph stuck -> inspect node live driver and wait reason.

Errors show category, sanitized reason, retryability, and next action. They never
print secret values.

## Design Rule

Before editing the SPA, read `packages/podium/web/DESIGN.md`. Its YAML tokens
and matching CSS custom properties are normative. Add missing design values to
both `DESIGN.md` and `src/styles/tokens.css` before using them, and keep
`npm run design:lint` clean.

## Verification

UI changes require appropriate frontend tests/lint/build. Managed-flow changes
also require real-run evidence that the browser, Podium API, Conductor state,
Linear projection, and archived artifacts show the same sanitized truth.
