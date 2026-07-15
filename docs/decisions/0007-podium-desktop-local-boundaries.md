# ADR-0007: Make Podium a local desktop control plane

## Status

Accepted by the user on 2026-07-15.

The Linear token-persistence portion of this decision was superseded on the
same date by
[ADR-0008](0008-store-linear-tokens-in-podium-sqlite.md). This ADR remains the
record of the broader Desktop, dual-database, and private-IPC decision.

The current SaaS/PostgreSQL implementation remains active until the replacement
gates in this ADR and
[`podium-desktop.md`](../product/podium-desktop.md) pass. Acceptance of the
target does not claim that those gates have already passed.

ADR-0010 refines this decision by making project choice part of one Desktop
Create Conductor flow and replacing customer installation/enrollment scripts
with immediate and application-start desired-binding reconciliation.

## Context

Podium currently runs as a SaaS BFF/static host backed by PostgreSQL. Local
Conductors enroll and communicate through public HTTP operations protected by
runtime/proxy bearer credentials. The browser owns account and custom Linear
application setup flows.

The approved direction is a local desktop client. The change must preserve the
runtime boundaries that keep workflow durability, provider SDKs, and Linear
authorization in their correct owners. It must remove, rather than rename, the
Podium-specific secrets and application-layer credential crypto made
unnecessary by a private local topology.

The main constraints are:

- preserve the four Python packages and their import boundaries;
- preserve Conductor's isolated `workflow.db` and Managed Run semantics;
- keep provider SDK/auth/config behavior inside Performer;
- make Podium the only Linear authorization and polling owner;
- remove PostgreSQL, public runtime HTTP, custom Linear applications, browser
  accounts, Podium bearer secrets, and Symphony credential encryption;
- fail closed and keep failures visible without exposing credentials;
- prove risky desktop, IPC, OAuth, SQLite, packaging, and platform assumptions
  before destructive removal.

## Decision

Use Tauri 2 as a native shell around the existing React UI. Tauri supervises a
local Podium Python sidecar and one isolated Conductor process for each active
desired project/repository binding. Conductor continues to launch installed
Performer control and fenced-turn processes.

Podium uses local SQLite `podium.db` for its control-plane state. Every
Conductor retains its own `workflow.db`; the databases are not merged or
dual-written.

Podium and Conductor communicate through a private per-child channel created by
Desktop, with inherited handles as the first-choice design. The channel uses
closed, dependency-free contracts in `performer_api`, process identity,
binding generation, and fencing metadata. It uses no bearer or shared secret
and exposes no public/LAN runtime listener. A named endpoint is a separately
approved fallback after an executed No-Go, not an implicit portability option.

Use one fixed public Linear application manifest and S256 PKCE with a fixed
loopback callback. Linear tokens remain in Podium memory and the OS credential
store. No token is stored in SQLite, returned to Tauri/React/Conductor, or
wrapped by Symphony encryption.

Hard-cut the old path only after replacement evidence passes. Do not implement
legacy data migration, compatibility adapters, or dual writes.

## Ownership consequences

### Podium

Owns Linear OAuth/token use, the project catalog, desired bindings, polling, delegation
epochs, dispatches, `podium.db`, and bounded UI/runtime snapshots. It does not
own `workflow.db`, Gate decisions, Performer SDKs, or Conductor internals.

### Conductor

Owns one project/repository Managed Run domain and `workflow.db`, including
plans, ordered work, turns, Gate/rework, recovery, runtime waits, evidence, and
manifests. It never receives a Linear token and does not open `podium.db`.

### Performer

Retains all provider SDK, authentication, configuration, session-handle,
response-parsing, readiness, and fenced-turn implementation.

### performer-api

Contains closed dependency-free JSON contracts used across role/process
boundaries. It does not contain IPC servers/clients, persistence, Linear calls,
provider implementations, secrets, arbitrary headers/URLs, or SDK types.

### Tauri and React

Tauri owns native lifecycle, bounded commands, and process supervision. React
owns presentation and form/view state. Neither owns durable workflow state,
Linear credentials, or provider logic.

## Rejected alternatives

### Merge Podium and Conductor

Rejected because it would collapse two durable ownership domains, weaken the
import boundary, and turn a transport migration into a workflow rewrite.

### Merge `podium.db` and `workflow.db`

Rejected because Podium and each Conductor have different lifecycle,
isolation, fencing, and recovery responsibilities. A merged or dual-written
database would create ambiguous workflow truth.

### Delete the Conductor package

Rejected because Conductor remains the project/repository-scoped durable
orchestrator and the only local process manager for Performer.

### Keep public runtime HTTP with a local bearer

Rejected because it preserves the secret lifecycle and public transport the
desktop topology is intended to remove. The inherited private channel plus
expected process identity and fencing is the approved boundary.

### Store Linear tokens in SQLite or a Symphony ciphertext

Rejected because the operating system already provides a credential store.
Symphony must not create a plaintext or custom-encryption fallback.

### Rewrite Podium or workflow logic in Rust

Rejected for this scope. Rust is the native shell and supervisor; the existing
Python role packages retain their business ownership.

### Migrate old SaaS/account/PostgreSQL data

Rejected as a compatibility expansion. This is an explicit hard cut after
replacement evidence.

## Consequences

- The desktop package must bundle target-specific Podium, Conductor, and
  Performer artifacts without ambient checkout, `PYTHONPATH`, PATH, or profile
  dependencies.
- SQLite migrations and polling/dispatch transactions become Podium-owned
  product infrastructure.
- Desktop must establish dynamic isolated sessions for multiple Conductors
  without parsing their domain payloads or silently opening a named listener.
- Shutdown must stop new work and drain active Conductor turns to a durable
  `workflow.db` safety point with bounded, visible failure semantics.
- Existing browser/public/PostgreSQL code temporarily remains as migration
  reference, but receives no new product features and is deleted only after
  Replacement Ready.
- Documentation and tests must distinguish the accepted target from the
  currently implemented path until the cutover completes.

## Feasibility and acceptance gates

Before state migration, Phase 1 must execute and archive proof for Tauri
packaging and sidecars, SQLite failure semantics, dynamic inherited sessions,
fixed-app PKCE, OS credential stores, the Conductor/Performer process chain,
and platform tray behavior.

Any failed proof stops implementation at No-Go. A different transport,
credential path, package topology, or customer-visible workflow requires a new
scope proposal and explicit user approval.

Destructive deletion requires successful automated and real evidence for the
complete onboarding, dispatch, Managed Run, Gate, wait, restart, OAuth failure,
security, and cleanup scenarios described in the product specification.
