# Runtime Installation

## Purpose

Customers install Symphony with one Podium-generated command. They do not clone
this repository, manage editable packages manually, or copy Linear tokens to a
runtime.

One Conductor binds one Linear project and one repository. Multiple isolated
Conductors may run on the same host for different projects.

## Identity And Naming

Podium assigns every Conductor an immutable six-character non-secret public id.
The operator supplies a single ASCII word of at most 16 characters or lets
Podium allocate an unused historical musician surname. Names are
case-insensitively unique within the Podium workspace. When the base list is
exhausted, Podium appends the shortest available numeric suffix.

The public project label is:

```text
symphony:conductor/Beethoven-k7m3p2
```

The label is operator metadata and never routing truth.

## Install Command

Podium creates a short-lived enrollment token for the named but unbound
Conductor and displays:

```bash
curl -fsSL https://<podium-host>/install.sh | bash -s -- \
  --enrollment-token <one-time-token>
```

The token is scoped to account, Conductor identity, OS/architecture, expiry,
and optional install profile. It is single-use and stored hashed in Podium.
Project and repository are assigned only after enrollment.

## Isolated Layout

Every installed Conductor has independent state:

```text
~/.symphony/
  bin/
  conductors/
    <runtime-id>/
      config/
      state/
      logs/
      versions/
```

Its service name, data root, local port, credentials, logs, update state, and
Performer artifacts cannot collide with another Conductor on the same host.
macOS uses a named `launchd` service and Linux uses a named `systemd` service
when available. Foreground/container modes preserve the same isolation.

## Enrollment And Binding

1. Installer downloads and verifies the runtime package.
2. Installer exchanges the one-time token for runtime identity, scoped runtime
   and proxy credentials, WebSocket URL, name, and public id.
3. Installer writes bootstrap configuration before process start.
4. Installer registers and starts the isolated Conductor service.
5. Conductor opens outbound heartbeat, config, report, and dispatch channels.
6. Podium marks the Conductor online but unbound.
7. The operator selects one unoccupied project and supplies that project's
   repository mapping.
8. Podium reserves the one-to-one binding and sends versioned project config.
9. Conductor validates the repository, creates its single project Performer
   binding, and durably acknowledges the config.
10. Podium verifies the report, adds the Linear project label, and enables
    dispatch.

Binding or rename failure preserves the prior working state and records a
sanitized, retryable operation with a concrete next action. Unbinding drains
Managed Runs, disables dispatch, removes the managed project label, and clears
project configuration without deleting the repository unless explicitly
requested.

## Connectivity

Conductor uses outbound connectivity to Podium for heartbeat, configuration,
commands, reports, log retrieval, and dispatch leasing. Customer machines do
not require public inbound callbacks. Linear access continues through Podium's
scoped proxy.

## Updates

Runtime updates are assigned by Podium channel: `stable`, `beta`, or `dev`.
Conductor downloads a version into its isolated directory, verifies checksum
and signature, switches its service target, restarts, and reports health. The
previous version remains available until the new version passes health checks;
rollback is explicit and project scoped.

## Install Profiles

- `local-dev`: foreground or user service with easy logs;
- `workstation`: isolated user daemon with auto-update;
- `server`: isolated system daemon with stricter restart/log behavior;
- `container`: foreground process without a service manager.

## Verification

Acceptance evidence must show token invalidation, unique name/public id,
isolated same-host services, credential storage, heartbeat, single-project and
single-repository binding, Conductor acknowledgement, project label, active
config version, updates, logs, unbind behavior, and absence of Linear OAuth
tokens from runtime files.
