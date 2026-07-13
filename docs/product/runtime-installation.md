# Runtime installation

## Current installer contract

Podium serves `/install.sh` for a machine that already has the `conductor`
command available. The script accepts a one-time enrollment token and Podium
URL, creates the selected data root, exchanges the token at
`/api/v1/runtime/enroll`, and writes the enrolled runtime and proxy credentials
to the local Conductor settings API.

By default it starts the installed `conductor` command as a detached local
process on port `8091`, waits for its local HTTP health response, and writes
its stdout/stderr to `/tmp/podium-conductor-<runtime-id>.log`. `--no-start`
leaves process startup to the operator.

The generated command can set the data root, Conductor command, and local port.
The fresh local `workflow.db`, logs, and generic Performer readiness state live
under that data root; separate Conductors should use separate roots. Provider
credential/config stores are provider-owned fixed process contexts and are not
materialized per attempt under Conductor state.

## What the current installer does not do

It does not download or verify a runtime package, register `systemd` or
`launchd`, manage update channels, install a service manager unit, or retain a
rollback image. Those behaviors must not be documented or relied on until they
exist in the installer.

## Binding after enrollment

Enrollment gives Podium an authenticated runtime identity. Podium then sends a
versioned project configuration through HTTP command polling. Conductor accepts
one project/repository instance, validates the local repository, acknowledges
the binding, and thereafter leases dispatches and reports state over HTTP.
Linear access remains server-side through Podium's proxy; Linear OAuth tokens
never enter installer output or Conductor configuration.

## Secret handling

Enrollment and proxy tokens are transient setup inputs. The installer must not
print them; its optional enrollment-result file is created with mode `0600`.
Operator logs and browser responses expose only sanitized status and identity
metadata.
