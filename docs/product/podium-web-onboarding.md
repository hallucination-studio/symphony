# Podium Web Onboarding

## Goal

Podium Web should guide a user from an empty account to a working Linear-powered
runtime without requiring them to understand OAuth, webhooks, or local daemon
configuration.

## Onboarding Steps

### 1. Connect Linear

The first setup screen asks the user to connect Linear.

Actions:

- Start OAuth install
- Show connected workspace after callback
- Fetch available teams and projects
- Confirm required permissions

Success state:

- Linear workspace connected
- Projects visible
- Installation health is green

### 2. Select Project and Scope

The user chooses where Symphony should operate.

Inputs:

- Linear project
- optional team
- required labels
- active states
- terminal states

Podium should default to a narrow scope and make broad workspace access an
explicit choice.

### 3. Map Repository

The user configures where work should happen.

Options:

- local path on a runtime machine
- Git URL to clone into runtime workspace
- future hosted workspace provider

For the first version, local path and Git URL are sufficient.

### 4. Install Runtime

Podium creates an enrollment token and displays the install command.

The page should show:

- command
- token expiry
- target runtime group
- expected OS/architecture
- copy button
- live enrollment status

After the user runs the command, the page updates to:

- runtime online
- version
- hostname
- last heartbeat
- available workspace roots

### 5. Run Smoke Check

Podium should provide a smoke check that verifies:

- runtime can reach Podium
- Podium can reach Linear
- runtime can call Podium Linear proxy
- pipeline runtime config validates
- optional test Linear issue can be created and read

The smoke check should not require Codex to make source changes. The first smoke
can stop at Linear proxy read/write and runtime dispatch readiness.

## Main Product Screens

### Integrations

- Linear connection status
- authorized workspace
- OAuth scopes
- token refresh health
- webhook health
- reconnect/revoke actions

### Runtimes

- runtime list
- online/offline state
- version
- update channel
- host metadata
- runtime groups
- last heartbeat
- install command generator

### Routing

- Linear project/team/label filters
- runtime group assignment
- repository mapping
- concurrency limits
- enabled/disabled state

### Pipeline

- issue
- runtime
- graph nodes
- capacity and leases
- attempts
- manifests and integration
- human waits
- Linear projection links

## Error Handling

Podium should turn setup failures into direct operator actions:

- Linear OAuth failed: reconnect Linear
- webhook delivery failed: verify public Podium URL and Linear webhook secret
- runtime offline: restart service or reinstall runtime
- version outdated: update runtime
- proxy denied: rotate runtime token or re-enroll runtime
- repo unavailable: fix repository mapping

## Product Principle

The user should experience Symphony as:

> Connect Linear, install a local runtime, choose a project, and let Podium route
> work.

They should not need to understand where OAuth tokens are stored, how webhook
signatures work, or which internal process runs Performer.
