# Podium Web

`docs/modules/podium-web.md` is the code-level baseline. This page records the
customer-facing scope without claiming unimplemented reporting detail.

## Purpose

Podium Web is the secret-safe browser surface for onboarding a workspace,
connecting Linear, selecting projects, enrolling and binding Conductors,
checking smoke status,
and observing current runtime and managed-run state. Podium serves it as a BFF
and committed static bundle.

Setup composes the same lifecycle APIs as the permanent management surfaces.
It resumes at the first incomplete readiness step across all selected projects:
Linear, Projects, Conductors, project/repository bindings, then Smoke. Completed
Linear authorization remains complete when a project or Conductor is added.

Integrations owns ongoing Linear application selection, authorization health,
project selection, reauthorization, and disconnect/revoke. Runtimes owns adding
and observing isolated Conductors. One project has at most one active binding;
one Conductor binds one project and one repository. A host may run multiple
Conductors when their identity, data root, port, credentials, and logs are
isolated.

## Retained surfaces

- Session registration, sign-in, sign-out, account identity, locale, redirects,
  and Turnstile configuration.
- Default or customer-owned Linear application selection, OAuth connection and
  reauthorization, multi-project selection, disconnect/revoke, repository
  mapping, enrollment, binding, and smoke actions.
- Runtime inventory, online/heartbeat state, cached instance logs, and permanent
  Add Conductor/install/reconnect paths.
- Managed-run parent and work-item state, active work item, thread id,
  `gate_status`, and sanitized blocking reason.

The browser polls ordinary authenticated HTTP endpoints. It has no WebSocket,
EventSource, socket URL, runtime credential, Linear token, refresh token,
cookie value, password, or client secret API surface.

## Evidence boundary

The current managed-run view renders only the summary fields above. Its existing
API response may include an optional safe acceptance/Gate summary, but this SPA
does not render it yet. Detailed plan approval, catalog, rubric, provenance,
manifest, artifact, command text/output, and findings remain Conductor-side
durable data. No separate evidence or gate child-issue tree is created by this
page.

## Design and verification

Read `packages/podium/web/DESIGN.md` before changing the SPA; its tokens are
normative. A Web change requires `npm run test`, `npm run lint`,
`npm run design:lint`, and `npm run build`. Add a browser check when rendered
behavior, layout, or browser networking changes.
