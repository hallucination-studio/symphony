# Podium Web

`docs/modules/podium-web.md` is the code-level baseline. This page records the
customer-facing scope without claiming unimplemented reporting detail.

## Purpose

Podium Web is the secret-safe browser surface for onboarding a workspace,
connecting Linear, enrolling and binding a Conductor, checking smoke status,
and observing current runtime and managed-run state. Podium serves it as a BFF
and committed static bundle.

## Retained surfaces

- Session registration, sign-in, sign-out, account identity, locale, redirects,
  and Turnstile configuration.
- Default or customer-owned Linear application selection, OAuth connection,
  project scope, repository mapping, enrollment, binding, and smoke actions.
- Runtime inventory, online/heartbeat state, cached instance logs, and the
  install/reconnect path.
- Managed-run parent and work-item state, active work item, thread id,
  `gate_status`, and sanitized blocking reason.

The browser polls ordinary authenticated HTTP endpoints. It has no WebSocket,
EventSource, socket URL, runtime credential, Linear token, refresh token,
cookie value, password, or client secret API surface.

## Evidence boundary

The current managed-run view renders only the summary fields above. Detailed
plan approval, catalog, rubric, provenance, manifest, artifact, and raw command
evidence remain Conductor-side durable data until an explicit API/UI contract
adds a sanitized projection. No separate evidence or gate child-issue tree is
created by this page.

## Design and verification

Read `packages/podium/web/DESIGN.md` before changing the SPA; its tokens are
normative. A Web change requires `npm run test`, `npm run lint`,
`npm run design:lint`, and `npm run build`. Add a browser check when rendered
behavior, layout, or browser networking changes.
