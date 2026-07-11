# Module baseline: `podium-web`

Status: proposed baseline, 2026-07-11.

## Responsibility

Podium Web is the existing Vite/React browser application served by Podium. It
keeps the current business experience and presentation contract while the
runtime implementation underneath changes from socket-oriented delivery to
HTTP polling. The browser never makes Linear calls with a token and never
receives Codex credentials, session secrets, or client secrets.

## Behavior held constant

Keep the current routes, authentication redirects, onboarding steps, Linear
application choice, project and repository selection, runtime enrollment and
binding actions, smoke action, home/operator/runtime pages, managed-runs page,
error states, translations, cookies, redirects, and responsive layout.

The managed-runs client continues to consume the existing report concepts:

```text
conductor, project, binding, runtime group, policy revision, profiles
run id, issue identifier, run state, active task, latest reason,
plan version/revision, approval status, thread id, work items
task id, title, objective, likely files, task state, gate status,
score/rubric summary, threshold, provenance, acceptance-catalog and artifact refs
```

The backend sends durable `policy_revision`/`plan_version` values and may send
`profiles: {}` when no runtime profile registry is needed. Web preserves
sanitized revision, approval, catalog, score, rubric, provenance, and artifact
summaries already present in the response. It must not grow controls for DAGs,
branch joins, checkpoint groups, cross-model reviewers, or a second acceptance
scheduler.

## API boundary

The client uses authenticated HTTP requests to the existing BFF routes. The
runtime itself is not a browser concern: Web does not open a WebSocket, display
presence heartbeats, issue `dispatch.available`, or fetch historical log chunks.
Current operator views receive the cached log tail included in the runtime
report or the retained managed-runs response.

Error rendering must preserve the existence, category, and next action of a
sanitized backend failure. It must not render token values, cookies, passwords,
client secrets, raw Codex profile values, or authorization headers.

## Target ownership

Keep the existing small boundaries for:

```text
src/api/         # typed BFF client, hooks, and response models
src/pages/       # route-level business views
src/components/  # shared visual pieces
src/styles/      # design tokens and global layout
src/i18n.tsx      # translations
```

Delete tests or helpers that only police retired identifiers; do not rewrite
pages or CSS for line-count reduction. `packages/podium/web/DESIGN.md` and its
token file remain normative. A visual change requires an explicit product
decision, not an incidental runtime refactor.

## Migration and exit gate

1. Snapshot current route, action, response, DOM, secret, and error behavior.
2. Update only API types/client assumptions required by the retained report.
3. Rebuild a small browser suite for auth/routes, BFF errors/secrets, setup,
   and product pages.
4. Run build, lint, design lint, and browser DOM/network/console checks at the
   existing desktop and mobile breakpoints.

The baseline is complete when a user can complete onboarding, bind a project,
run smoke, view runtime and managed-run status, and see a concrete error exactly
as before, while browser network inspection shows no token leakage and no
WebSocket use.
