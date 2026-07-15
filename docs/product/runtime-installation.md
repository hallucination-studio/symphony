# Runtime creation and Desktop supervision

## Target contract

Podium Desktop owns Conductor creation and process lifecycle. The customer does
not install, enroll, configure, or start a Conductor with a shell script or
ambient command.

The only creation flow is **Create Conductor**:

1. React chooses one unbound project from Podium's accessible Linear catalog.
2. A native Tauri command opens the directory picker. React never supplies a
   free-text repository path.
3. Tauri canonicalizes the chosen existing repository and forwards project id
   plus repository path to Podium over the private bounded command bridge.
4. Podium atomically persists one desired binding containing stable Conductor
   identity, project, repository, generation, isolated data-root key, and
   `desired=running`.
5. Desktop immediately starts the target-specific bundled Conductor with its
   isolated private IPC, data root, and log.
6. Matching session/configuration ACK and Performer readiness move observed
   state from `pending` through `starting` to `ready`.

The desired binding commits before process start. A failed start records a
stable observed failure and preserves desired state; it does not create a half
binding, roll back customer configuration, or claim readiness.

## Application restart

Whenever the user opens Podium Desktop, Desktop reads every active desired
binding and automatically starts or reconnects the matching bundled Conductor.
Each project/repository owns a separate process, private channel, data root,
`workflow.db`, and logs. Duplicate active project or Conductor identity fails
closed before process start.

Podium does not launch at OS login in the MVP. Auto-start means “start desired
Conductors when Podium Desktop is running,” not a background daemon or system
service.

## Packaging boundary

Production resolves Podium, Conductor, and Performer only from the signed
target-specific Desktop bundle and approved application-data paths. It does not
use `/install.sh`, enrollment tokens, public runtime URLs, detached ports,
checkout paths, `PYTHONPATH`, ambient Python, or an ambient `conductor` command.
`make install`, `make dev`, and direct commands remain repository development
tools only.

Linear authorization remains inside Podium. Tokens, headers, and credentials
never enter the native create result, React, Conductor configuration, process
arguments, logs, or snapshots.

## MVP exclusions

The MVP does not add binding edit/revision UI, remote Conductors, automatic
repository discovery, system service registration, launch at login, update
channels, or a second process manager. Existing legacy installer/enrollment
code is retained only until its ordered Phase 8 deletion and is not an accepted
target path.
