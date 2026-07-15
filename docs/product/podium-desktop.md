# Podium Desktop target architecture

Status: accepted by the user on 2026-07-15. Implementation is governed by
[ADR-0007](../decisions/0007-podium-desktop-local-boundaries.md) and the
per-task workflow. This document defines the approved target; it does not
claim that the current SaaS path has already been replaced.

## Product outcome

Symphony becomes a local desktop product while preserving its four Python
packages and their role boundaries:

```text
Podium Desktop (Tauri 2 + the existing React UI)
  -> Podium local process + podium.db
       OAuth, projects, bindings, polling, dispatch, safe snapshots
  -> one or more isolated Conductor processes + workflow.db
       one project + repository, Managed Runs, Gate, recovery, runtime waits
       -> installed Performer control and fenced turns
```

The target removes the Podium SaaS/public-browser boundary, PostgreSQL,
runtime enrollment and bearer transport, custom Linear applications, browser
accounts, and Symphony-owned credential encryption. It is a hard cut after
replacement evidence passes; it is not a compatibility migration.

## Package and process boundaries

The packages `performer-api`, `performer`, `conductor`, and `podium` remain.
Their import rules stay build invariants:

- `performer_api` imports no product role package.
- Podium, Conductor, and Performer may import `performer_api`.
- Podium, Conductor, and Performer do not import one another.
- Conductor launches installed Performer commands and never imports Performer
  implementation modules.
- Provider SDKs, provider authentication/configuration, generated provider
  types, provider handles, and provider response parsing remain Performer-only.

`performer_api` may contain dependency-free, closed JSON contracts needed
across role or process boundaries. Those contracts may describe Managed Runs,
Performer control, or the approved local Podium/Conductor protocol. They must
not execute work, persist state, call Linear, implement IPC, contain arbitrary
URLs/headers, expose secrets, or contain provider-specific data.

The Tauri shell owns windows, tray lifecycle, single-instance enforcement,
bounded native commands, and process supervision. It does not absorb Linear,
dispatch, Managed Run, Gate, or provider business logic.

## Durable ownership

Podium owns `podium.db` in the OS application-data directory. It is the only
process that opens the database for writes. The approved schema contains only
local control-plane state: non-secret Linear metadata and selected projects,
bindings and generations, polling checkpoints, delegation epochs, dispatches,
leases, runtime commands, bounded reports, failures, and application events.

Podium SQLite uses explicit migrations, foreign keys, WAL, a busy timeout, a
single writer, short transactions, and bounded reads. Observation, delegation
epoch, dispatch insertion, and checkpoint advancement commit atomically.

Each Conductor continues to own an isolated `workflow.db`. It remains the only
durable truth for its Managed Runs, plans, work items, turns, Gate results,
runtime waits, evidence, and manifests. Symphony does not merge or dual-write
`podium.db` and `workflow.db`.

## Linear authorization and secrets

The desktop uses one fixed public Linear application manifest with S256 PKCE
and a fixed loopback callback. The UI, environment, and databases cannot
override the client id, callback, scopes, actor, or manifest revision. The
client contains no Linear application secret and offers no custom application
form.

Linear access and refresh tokens are held only in Podium process memory and
the operating-system credential store. Podium stores only non-secret metadata
in SQLite. If the credential store is unavailable, authorization fails closed;
there is no plaintext file, SQLite token column, or Symphony encryption
fallback.

The target removes all Podium runtime/proxy/enrollment bearer secrets, secret
hashes, encryption keys, ciphertext fields, and Symphony encrypt/decrypt code.
Generic redaction of external credentials remains mandatory.

## Private local boundary

Desktop establishes a private channel for each expected Podium/Conductor
child. Inherited socketpair/pipe handles are the approved first choice. A
named Unix-domain socket or Windows named pipe requires Phase 1 evidence that
the inherited design is not feasible and separate approval of a scope change.

Each Conductor session is bound to its expected process identity, component
and contract versions, instance, project, conductor id, binding generation,
and fresh session nonce. The nonce is fencing metadata, not a credential.
There is no public or LAN runtime listener and no bearer, capability token,
cookie, API key, or shared secret.

Podium remains the only Linear token owner. Conductor requests only allowlisted
project-scoped Linear reads or projections through the closed local protocol;
Podium injects authorization internally and returns validated, bounded,
secret-free results.

## Preserved runtime semantics

The transport and control-plane migration preserves:

- complete baseline and incremental cursor pagination;
- atomic checkpoints and delegation epochs;
- one dispatch per issue/delegation epoch;
- blocker re-evaluation, lease reclaim, and stale fencing rejection;
- one active Conductor binding per project and one project/repository per
  Conductor;
- bounded, ordered work items and verification commands;
- one read-only Performer Gate, one automatic rework, then visible block;
- immutable plan, policy, attempt, lease, and fencing provenance;
- durable runtime approval/tool-input waits and Linear projection;
- structured sanitized logs and durable/UI/Linear error visibility;
- the installed Performer subprocess and provider-isolation boundary.

## Desktop experience

The existing React application and `packages/podium/web/DESIGN.md` remain the
visual source of truth. The full window contains Overview, Linear, Runtimes,
Performer, and Managed Runs surfaces. Setup follows the first incomplete real
readiness step: connect Linear, select projects, bind a repository and
Conductor for each project, validate Performer, then become ready.

The first macOS menu-bar popover is read-only except for `Open Podium` and
`Quit`. It shows bounded health and needs-attention state. Review suggestions
do not add actions or other product features.

## Approved implementation assumptions

The user approved these decisions as one scope on 2026-07-15:

1. Tauri 2 with the existing React and TypeScript UI.
2. The Podium Python package remains a local sidecar rather than a Rust rewrite.
3. Desktop supervises one Podium and multiple isolated Conductors.
4. One local profile connects to one Linear organization and may select many
   projects.
5. Each selected project has its own repository binding, Conductor data root,
   and process.
6. All platforms use inherited private channels first; named endpoints require
   a separately approved fallback.
7. Closing the main window hides it; explicit Quit performs bounded shutdown.
8. The first release does not launch at login.
9. Old Podium/account/PostgreSQL data and old `workflow.db` files are not
   automatically migrated.
10. macOS has the complete popover; Windows has an equivalent tray; Linux may
    use the approved native-menu plus full-window fallback.
11. The fixed public Linear manifest uses S256 PKCE and is not configurable.
12. A transient runtime or Linear failure stops new work; an already-started
    turn may finish to `workflow.db` before later projection resumes.

These are approved product decisions but not implementation proof. Phase 1
must execute real feasibility checks for Tauri packaging, target-specific
Python sidecars, SQLite failure semantics, dynamic inherited sessions, PKCE,
OS credential stores, the Conductor/Performer chain, and platform tray
behavior. A failed proof is a No-Go and requires a new scope proposal; it is
not permission to add a fallback silently.

## Migration and deletion gates

New and old paths do not dual-write. Existing code remains only as behavior
reference while the local replacement is built. Destructive removal begins
only after automated and real evidence proves fixed-app onboarding, a complete
Managed Run, Gate rework/block, runtime waits, restart/recovery, OAuth failure,
state/report/UI/Linear parity, and the absence of old secrets and transports.

Each implementation task is independently scoped, tested, simplified,
reviewed, verified, and committed. A review comment without a trace to this
document, the current task acceptance, or an existing invariant cannot expand
the product.

## Explicitly out of scope

- merging or deleting the four Python packages;
- SaaS, multi-tenancy, remote Conductors, or cloud synchronization;
- custom Linear applications or a client secret;
- PostgreSQL or another network database in the target;
- a Podium/local bearer, capability secret, or custom key management;
- legacy data migration, compatibility shims, or dual writes;
- a new DAG, parallel task scheduler, or second production backend;
- automatic updates, launch at login, telemetry, diagnostic bundle export, or
  a visual redesign.
