# Podium Web

## Purpose

Podium Web guides an operator from an empty account to a working
Linear-powered runtime, then shows Managed Runs health without exposing secrets
or requiring the operator to understand internal process boundaries.

The UI is served by Podium's BFF/static host. Browser responses never include
Linear access tokens, refresh tokens, webhook signing secrets, runtime
credentials, session cookies, passwords, client secrets, or raw profile
secrets.

## Onboarding

### Choose And Authorize Application

Podium defaults to the deployment-owned Linear application. An advanced option
lets an operator stage a custom application by entering its client id, client
secret, and webhook signing secret. The page displays Podium's fixed callback
and webhook URLs and may link to a pre-populated Linear application manifest;
it never accepts a custom callback URL.

Authorization shows the candidate application's callback acceptance: actor,
scopes, organization, app user, token health, webhook health, and concrete
failure actions. A replacement application remains a candidate until current
Managed Runs drain and all bound Conductors are prepared for cutover.

### Select Projects

The operator selects one or more projects visible to the active installation.
Podium validates read/write access and displays each project's access,
selection, binding, webhook, and reconciliation health. Selection does not add
the app user to project members.

### Install Conductor

Podium asks for one short English word or allocates an unused historical
musician surname, then creates a short-lived enrollment token and install
command. The generated Conductor is initially unbound. The page shows its
public id, name, host, service identity, version, last heartbeat, and isolated
data root.

### Bind Project And Repository

After the Conductor is online, the operator chooses one selected project that
does not already have an active Conductor and configures that project's local
path or Git URL. One Conductor may bind one project only; each project may have
one active Conductor only.

Podium waits for the Conductor to validate the repository and report the exact
binding. It then adds
`symphony:conductor/<Name>-<six-character-public-id>` to the Linear project.
The label is visible context, not routing truth.

### Smoke Check

The smoke check verifies callback acceptance, installation identity, project
access, signed webhook delivery or visible polling fallback, runtime
connectivity, binding identity, repository readiness, Linear proxy access,
runtime config validity, and project label state. It does not require Codex to
make source changes.

## Main Surfaces

Integrations shows application source, active and candidate installations,
organization, scopes, token refresh, webhook delivery, reconciliation polling,
cutover, reconnect, and revoke actions.

Projects shows selected projects, access health, repository mapping, bound
Conductor, managed project label, routing readiness, and actionable errors.

Runtimes shows project-scoped Conductors, name/public id, online state, service
identity, version, update channel, project, repository, policy revision, last
heartbeat, and staged config version. It also supports install, bind, unbind,
rename, replace, and log inspection actions.

Managed Runs shows parent runs and work items, active policy, capacity, backend
threads, verification and checkpoint results, file impact, blocked work, human
and runtime waits, Linear projection links, and sanitized errors.

## Error Surfaces

Failures become operator actions:

- callback rejection -> fix app configuration or authorize again;
- missing scope or non-app actor -> correct the application and reauthorize;
- webhook unhealthy -> repair the configured webhook while degraded polling
  remains visible;
- candidate cutover blocked -> drain runs or restore an offline Conductor;
- project inaccessible -> widen Linear access or deselect the project;
- project already bound -> replace or unbind its current Conductor;
- runtime offline -> restart or reinstall the named service;
- repository unavailable -> fix the project repository mapping;
- proxy denied -> rotate or re-enroll runtime credentials;
- profile materialization failure -> fix runtime profile secrets.

Errors show category, sanitized reason, retryability, timestamps, and next
action. They never print secret values.

## Design Rule

Before editing the SPA, read `packages/podium/web/DESIGN.md`. Its YAML tokens
and matching CSS custom properties are normative. Add missing design values to
both `DESIGN.md` and `src/styles/tokens.css` before using them, and keep
`npm run design:lint` clean.

## Verification

UI changes require frontend tests, lint, design lint, build, and real-browser
checks. Managed-flow changes also require real evidence that Podium, the bound
Conductor, Linear project, webhook/reconciliation intake, Managed Runs view, and
archived artifacts show the same sanitized truth.
