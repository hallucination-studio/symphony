# Runtime Installer and Updates

## Goal

Customers should install the Symphony runtime with one Podium-generated command.
They should not need to clone the repository, manage Python packages manually,
or copy Linear tokens.

## Install Command Shape

Podium generates a short-lived enrollment token and displays:

```bash
curl -fsSL https://<podium-host>/install.sh | bash -s -- \
  --enrollment-token <one-time-token>
```

The command is scoped to:

- customer account
- runtime group
- operating system
- architecture
- expiry time
- optional install profile

The enrollment token should be single-use or short-lived. If copied later, it
should no longer enroll a new runtime.

## Installed Components

The installer should place files under:

```text
~/.symphony/
  bin/
  config/
  state/
  logs/
  versions/
```

It installs:

- `symphony` CLI
- `conductor` daemon
- `performer` worker package
- service definition
- auto-update metadata

On macOS the service should use `launchd`. On Linux it should use `systemd` when
available, with a fallback foreground mode for development and containers.

## Enrollment Flow

1. Installer downloads the runtime package.
2. Installer verifies checksum/signature.
3. Installer writes local config.
4. Installer starts Conductor.
5. Conductor calls Podium enrollment endpoint with the one-time token.
6. Podium returns runtime identity and scoped credentials.
7. Conductor stores runtime credentials locally.
8. Conductor starts heartbeat.
9. Podium shows the runtime as online.

Runtime credentials:

- `runtime_id`
- `runtime_secret` or mTLS credential
- `dispatch_token` or pull-channel credential
- `linear_proxy_token`
- rotation metadata

## Update Model

The runtime should auto-update by default, with controls in Podium.

Recommended channels:

- `stable`
- `beta`
- `dev`

Update flow:

1. Runtime checks Podium for assigned version.
2. Podium returns version metadata, URL, checksum, and signature.
3. Runtime downloads into `versions/<version>`.
4. Runtime verifies checksum/signature.
5. Runtime switches symlink or service target.
6. Runtime restarts gracefully.
7. Runtime reports new version and health.

Updates must be rollback-capable. The previous version remains installed until
the new version passes health checks.

## Runtime Connectivity

The managed product should prefer outbound runtime connections:

- Conductor polls Podium for dispatches, or
- Conductor keeps a long-lived WebSocket/SSE channel to Podium.

Inbound HTTP callbacks to customer machines should remain a development or
self-hosted option, because most users will not have public network routing to
their local machine.

## Installer Profiles

Initial profiles:

- `local-dev`: foreground or user-level service, easy logs, no privileged setup
- `workstation`: user-level daemon, auto-update enabled
- `server`: system daemon, stricter logs and restart behavior
- `container`: no service manager, runs as foreground process

## Uninstall

The runtime should support:

```bash
symphony uninstall
```

Uninstall should:

- stop the service
- remove binaries
- optionally remove local state
- revoke runtime credentials in Podium

Local repository workspaces should not be deleted without explicit user
confirmation.
