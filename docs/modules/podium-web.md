# Module baseline: `podium-web`

Status: module boundary amended by accepted ADR-0006 on 2026-07-13. Existing UI
behavior is preserved; the capability-driven Performer drawer remains target
implementation work and this document does not claim a live browser run.

## Responsibility

`packages/podium/web` is the Vite/React/TypeScript single-page application
served by Podium's committed static bundle. It renders onboarding, Linear
connection/reauthorization/project selection, Conductor enrollment/binding,
runtimes, logs,
smoke checks, and managed runs. It is a BFF client only: Linear tokens, refresh
tokens, session secrets, passwords, and client secrets never enter browser API
responses.

Read `packages/podium/web/DESIGN.md` before changing this module. Its tokens
are normative and must stay synchronized with `src/styles/tokens.css`.

Setup is a readiness composition, not a second owner of Linear or runtime
state. It derives the first incomplete step from the active installation, all
selected projects, available Conductors, ready project/repository bindings, and
the current smoke result. Integrations owns durable Linear and project actions;
Runtimes owns permanent Add Conductor and explicit project/repository binding
actions. Setup and those pages reuse the same installation, project-selection,
enrollment, binding, and runtime polling hooks rather than maintaining parallel
wizard state. Adding either resource resumes only the downstream Setup work and
never asks the user to repeat a healthy Linear authorization.

The binding model is one-to-one: one selected project has at most one active
Conductor, and one Conductor binds one project and one repository. Multiple
Conductors on one host remain independent through distinct identities, data
roots, ports, credentials, and log paths.

## Runtime presentation

- The browser polls ordinary HTTP endpoints. It has no WebSocket, socket URL,
  subscription, or live log-stream client.
- Runtimes show online state and last heartbeat from Podium's HTTP presence
  state, and fetch instance logs through the authenticated log route.
- Managed-run pages consume `work_items`, `active_work_item_id`, and
  `backend_session_id`. Conductor normalizes its internal task/report names to
  that DTO before Podium Web sees them.
- `runtime_group_id` remains displayable as a stable alias even though Podium
  no longer stores a runtime-group table.
- The browser receives only sanitized selected profile metadata,
  binding-generation/hash, generic readiness, and closed Performer
  capabilities. Live login/config/Check controls are provider-neutral and
  capability-driven; secret inputs and config source remain transient local
  state and never enter client caches.

## What the current UI does not claim

The managed-run pages render run/task/gate status and operator-facing errors.
They do not currently render all local plan approval, catalog, rubric,
provenance, manifest, or artifact evidence. The existing API may return an
optional safe summary, but browser rendering remains deferred; do not expose
full command/output, findings, or reference locations in this module.

## Verification

For any UI change run the module's `npm run test`, `npm run lint`, `npm run
build`, and `npm run design:lint`. Use a real browser check when the change
alters rendered behavior, layout, or browser networking.
