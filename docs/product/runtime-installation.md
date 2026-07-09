# Runtime Installation

## Purpose

Customers install the Symphony runtime with one Podium-generated command. They
do not clone this repository, manage editable Python packages manually, or copy
Linear tokens to the runtime.

## Install Command

Podium creates a short-lived enrollment token and displays:

```bash
curl -fsSL https://<podium-host>/install.sh | bash -s -- \
  --enrollment-token <one-time-token>
```

The token is scoped to account, runtime group, OS/architecture, expiry, and
optional install profile. It is single-use where possible and stored hashed in
Podium.

## Installed Layout

The installer places runtime files under a managed directory such as:

```text
~/.symphony/
  bin/
  config/
  state/
  logs/
  versions/
```

It installs the runtime CLI, Conductor daemon, Performer worker package, service
definition, runtime config, update metadata, and log directories. macOS uses
`launchd`; Linux uses `systemd` when available, with foreground/container modes
for development and containers.

## Enrollment

1. Installer downloads the runtime package.
2. Installer verifies checksum and signature.
3. Installer writes local bootstrap config.
4. Installer starts Conductor.
5. Conductor calls Podium enrollment with the one-time token.
6. Podium validates scope and returns runtime identity plus scoped credentials.
7. Conductor stores credentials locally.
8. Conductor opens heartbeat/config/dispatch connectivity.
9. Podium marks the runtime online.

Runtime credentials include runtime id, identity secret or certificate, dispatch
credential, Linear proxy token, runtime group, and rotation metadata.

## Connectivity

The managed product prefers outbound runtime connectivity. Conductor leases
dispatches over Podium APIs or maintains a long-lived WebSocket/SSE channel.
Inbound HTTP callbacks to customer machines are development or self-hosted
options, not the default SaaS posture.

## Updates

Runtime updates are assigned by Podium channel:

```text
stable
beta
dev
```

Update flow:

1. Runtime checks assigned version and channel.
2. Podium returns URL, checksum, signature, and rollback metadata.
3. Runtime downloads into `versions/<version>`.
4. Runtime verifies checksum and signature.
5. Runtime switches service target or symlink.
6. Runtime restarts gracefully.
7. Runtime reports version and health.

The previous version remains installed until the new version passes health
checks. Rollback is an explicit supported operation.

## Install Profiles

Initial profiles:

- `local-dev`: foreground or user service with easy logs;
- `workstation`: user daemon with auto-update;
- `server`: system daemon with stricter restart/log behavior;
- `container`: foreground process without service manager.

## Uninstall

`symphony uninstall` stops the service, removes binaries, optionally removes
local state, and revokes runtime credentials in Podium. Repository workspaces
are not deleted without explicit confirmation.

## Verification

Acceptance evidence must show package verification, enrollment token invalidation,
runtime credential storage, heartbeat, active config version, update channel,
rollback metadata, logs, and absence of Linear OAuth tokens in runtime files.
