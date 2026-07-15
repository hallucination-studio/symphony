# ADR-0010: Create and auto-start Conductors from Podium Desktop

## Status

Accepted by the user on 2026-07-15.

This ADR refines ADR-0007's Desktop supervision decision. It removes the
standalone selected-project setup state and the customer-facing Conductor
installation-script flow. It does not change one-project Conductor isolation,
binding generations, private IPC, `workflow.db`, or Performer ownership.

## Context

The earlier task plan separated project selection, repository binding, and
Conductor startup into different customer steps. That creates an unnecessary
half-configured state: a project can be selected without a repository or a
running Conductor. It also retains installation-script language even though the
Desktop bundle already owns the Conductor and Performer artifacts and process
supervision.

For a local Desktop product, the useful customer object is a Conductor bound to
one Linear project and one local repository. The project choice belongs in the
Create Conductor action.

## Decision

Podium keeps a read-only catalog of projects discovered from the authorized
Linear installation. There is no separate customer mutation that persists a
set of selected projects.

The customer creates a Conductor in one bounded Desktop flow:

1. choose one unbound accessible Linear project;
2. invoke one native Create Conductor command; Tauri opens the directory
   picker and forwards the canonical repository path internally, while React
   supplies only the project id and never supplies a free-text path;
3. submit one closed Create Conductor command;
4. Podium atomically creates the desired binding, stable Conductor identity,
   generation, isolated data root, and desired running state;
5. Desktop immediately reconciles desired state and starts the bundled
   Conductor with private IPC;
6. readiness is reached only after matching process/session/configuration and
   Performer readiness are observed.

The SQLite transaction and process start are deliberately two ordered facts,
not a fake cross-system transaction. A committed binding has `desired=running`
and begins in `observed=pending`. Desktop then reports `starting`, `ready`, or
an actionable `failed` observation. Start failure preserves the desired
binding so the next Desktop start can reconcile it; it does
not leave a selected-only state and does not roll back customer configuration.

Opening Podium Desktop always reconciles all active desired bindings and starts
or reconnects their isolated Conductors automatically. A process-start failure
does not delete the desired binding or pretend readiness; it remains visible
and is reconciled again on the next application start.

Production does not ask the customer to run `make install`, `make dev`, a shell
installer, or an ambient `conductor` command. The Desktop bundle resolves only
its packaged target-specific Podium, Conductor, and Performer artifacts.
Repository checkout commands remain developer tooling only.

The MVP does not add binding edit/revision UX, launch-at-login, background
service installation, remote Conductors, automatic repository discovery, or a
second process manager.

## Consequences

- An active desired binding, not a standalone selection flag, is the source of
  polling and dispatch eligibility.
- Linear UI shows authorization and the accessible project catalog; Conductor
  creation owns project choice and repository choice.
- Setup becomes `Connect Linear -> Create Conductor(s) -> Validate Performer ->
  Ready`.
- Project uniqueness and repository/Conductor identity conflicts are checked in
  the Create Conductor transaction before any process starts.
- Desktop process reconciliation is required both immediately after creation
  and on every application start.
- Existing selected-project schema and tasks are removed from the target rather
  than retained as a compatibility layer.

## Rejected alternatives

### Keep project selection as a separate persisted step

Rejected because it creates a customer-visible state that cannot run and
duplicates the project identity already owned by the desired binding.

### Keep a Conductor installation script

Rejected because it contradicts Desktop-owned packaged artifacts, lifecycle,
private IPC, isolated data roots, and automatic restart reconciliation.

### Automatically bind every discovered project

Rejected because repository choice is required and one project must map to one
explicit local repository/Conductor boundary.
