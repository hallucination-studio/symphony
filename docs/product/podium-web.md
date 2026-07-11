# Podium Web

## Purpose

Podium Web guides an operator from an empty account to a working
Linear-powered runtime, then shows Managed Runs health without exposing secrets
or requiring the operator to understand internal process boundaries.

The UI is served by Podium's BFF/static host. Browser responses never include
Linear access tokens, refresh tokens, runtime credentials, session cookies,
passwords, client secrets, or raw profile secrets.

## Onboarding

### Choose And Authorize Application

The application source is a two-choice segmented control. For a workspace with
no saved customer-owned configuration, Default application is selected initially
and shows the Podium-managed application status plus one clear authorize action.
An existing customer-owned choice reopens in that mode. In default mode the page
does not render customer-owned application fields, placeholders, or disabled
credential controls.

Choosing **Bring your own application** reveals only client id and client secret
fields plus the read-only Podium-owned callback URL. There is no callback URL
input. The secret is write-only and is cleared after submission. Switching back
to the default application hides the entire customer-owned configuration.

Authorization shows actor, exact scopes, organization, app user, token/refresh
health, polling health, and concrete failure actions. The OAuth callback returns
`303 See Other` to `/setup/linear`; successful authorization and denied consent
are both visible there without a standalone callback page. Same-identity
reauthorization rotates credentials in place. A different-identity application
remains a candidate until current Managed Runs drain and all bound Conductors
are prepared for atomic cutover.

### Select Projects

The operator selects one or more projects visible to the active installation.
Podium fully paginates project discovery, validates read/write access, and
displays each project's access, selection, binding, and polling health.
Selection does not add the app user to project members.

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
access, baseline/incremental polling checkpoints, runtime connectivity, binding
identity, repository readiness, Linear proxy access, runtime config validity,
and project label state. It does not require Codex to make source changes.

Starting a smoke check first evaluates durable Podium prerequisites. A failed
prerequisite produces an immediate sanitized failure and does not complete
onboarding. Otherwise Podium creates one versioned check, durably queues one
idempotent `smoke.check` command per ready project Conductor, and returns
`running`. Each Conductor reports through its authenticated runtime channel;
Podium validates the check, runtime, binding, result shape, and error fields.
It remains `running` until every expected Conductor reports, then atomically
records `passed` or `failed`. Missing reports become an explicit timeout rather
than an indefinite wait. Only the final `passed` state completes onboarding.

Each Conductor checks the exact assigned binding and repository, the applied
runtime-config version, Linear proxy access, and the exact managed project
label id/name pair. It persists the immutable result before authenticated
delivery. Replayed commands reuse that evidence without rerunning Linear
checks; retryable delivery failures use durable backoff, while terminal
rejections remain stopped until a new smoke check is issued. Delivery state and
sanitized reasons are visible through the local `/api/smoke-checks` endpoint,
structured process logs, and the bound instance log.

## Main Surfaces

Integrations shows application source, active and candidate installations,
organization, scopes, token refresh, polling checkpoints, cutover, reconnect,
and revoke actions.

Projects shows selected projects, access health, repository mapping, bound
Conductor, managed project label, routing readiness, and actionable errors.

Runtimes shows project-scoped Conductors, name/public id, online state, service
identity, version, update channel, project, repository, policy revision, last
heartbeat, and staged config version. It also supports install, bind, unbind,
rename, replace, and log inspection actions.

Managed Runs shows parent runs and work items, plan/policy revisions, gate
scores and rubric evidence, file impact, blocked work, human/runtime waits,
Linear projection links, and sanitized errors.

## Error Surfaces

Failures become operator actions:

- callback rejection -> fix app configuration or authorize again;
- missing scope or non-app actor -> correct the application and reauthorize;
- refresh rejected -> reauthorize before new managed traffic can start;
- polling degraded -> inspect the retry, last checkpoint, and next attempt;
- candidate cutover blocked -> drain runs or restore an offline Conductor;
- project inaccessible -> widen Linear access or deselect the project;
- project already bound -> replace or unbind its current Conductor;
- runtime offline -> restart or reinstall the named service;
- repository unavailable -> fix the project repository mapping;
- proxy denied -> rotate or re-enroll runtime credentials;
- Codex runtime materialization failure -> stage the approved runtime seed.

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
Conductor, Linear project, polling intake, Managed Runs view, and archived
artifacts show the same sanitized truth.
