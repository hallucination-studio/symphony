# Module baseline: `podium-web`

Status: implemented code baseline, 2026-07-12. UI behavior is preserved; this
document does not claim a browser run against a live Podium instance.

## Responsibility

`packages/podium/web` is the Vite/React/TypeScript single-page application
served by Podium's committed static bundle. It renders onboarding, Linear
connection/project selection, Conductor enrollment/binding, runtimes, logs,
smoke checks, and managed runs. It is a BFF client only: Linear tokens, refresh
tokens, session secrets, passwords, and client secrets never enter browser API
responses.

Read `packages/podium/web/DESIGN.md` before changing this module. Its tokens
are normative and must stay synchronized with `src/styles/tokens.css`.

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
- The browser receives only sanitized selected profile/revision metadata and
  readiness; it does not configure credential slots or render profile TOML.

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
