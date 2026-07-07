# Podium Web

React + TypeScript single-page app for the Podium onboarding and operations UI.
Built with Vite, TanStack Query for server state, and React Router.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts Vite on http://localhost:5173 and proxies `/api/*` to a
Podium backend running on http://127.0.0.1:8090. Start the backend separately:

```bash
# from the repo root
.venv/bin/python -m podium.cli --port 8090
```

## Build

```bash
npm run build
```

The build compiles the app and emits static assets directly into
`../src/podium/static/` (the directory the Podium backend serves). `base` is set
to `./` so assets resolve under whatever path Podium mounts the SPA at, and the
backend provides SPA fallback so client-side routes (e.g. `/setup`) load
`index.html`.

The built assets are committed so Podium serves the UI out of the box. Re-run
`npm run build` and commit the result whenever the frontend changes.

## Scripts

- `npm run dev` — Vite dev server with API proxy
- `npm run build` — type-check and build into the served static dir
- `npm test` — run Vitest unit tests once
- `npm run lint` — ESLint

## Structure

- `src/api/client.ts` — typed client covering every Podium BFF endpoint
- `src/api/hooks.ts` — TanStack Query hooks
- `src/api/types.ts` — response contracts
- `src/pages/` — one page per route (Home, Setup, Integrations, Runtimes, Pipeline)
- `src/components/` — shared UI (onboarding step list, status badges)
- `src/styles/` — design tokens and app styles
