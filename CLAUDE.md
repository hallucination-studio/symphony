# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Companion docs

- `AGENT.md` (hardlinked as `agent.md`) is the detailed operating guide: product boundaries, code standards, real-run testing rules, the acceptance-scoring rubric, and Linear test-project tooling. Read it for anything involving orchestration, acceptance, or real Linear runs — those rules are mandatory and not repeated here.
- `README.md` documents the runtime flow, the Conductor/Podium API surfaces, and configuration.
- `packages/podium/web/DESIGN.md` is the visual-identity source of truth for the Podium web UI (see below).

## Commands

```bash
make install        # create .venv and install all four packages editable
make test           # full pytest suite (sets PYTHONPATH across all package srcs)
make dev            # run Conductor on :8081 with data-root ./.conductor
make stop           # kill Makefile-launched Conductor/Performer processes
```

`make test` is the canonical way to run tests because pytest needs every package's `src/` on `PYTHONPATH`. To run a single test file or case, reuse that same path prefix:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_conductor_pipeline.py -q
# single case:
PYTHONPATH=... .venv/bin/python -m pytest tests/test_podium_auth.py::test_login -q
```

Run the services directly:

```bash
.venv/bin/performer --mode plan|execute|verify --attempt-request-path /tmp/request.json --attempt-result-path /tmp/result.json
.venv/bin/conductor --port 8081 --data-root ./.conductor
.venv/bin/podium api --host 127.0.0.1 --port 8090
```

Real Linear E2E is skipped by default; it needs a sourced `.env` — see the "Real Full-Flow Testing Rules" and Linear tooling in `AGENT.md`.

## Architecture

Symphony is **one product** split into four Python packages under `packages/`, each a role in the "orchestra". Package boundaries are runtime boundaries, not product boundaries — keep user-facing language anchored on Symphony as the whole system.

- **`performer-api`** — shared contracts: pipeline DTOs, frozen gate snapshots, graph/attempt state, runtime config, ops projections/models, and registration DTOs. The other three depend on it; it depends on none of them.
- **`performer`** — the execution worker. It only runs fenced `plan`, `execute`, or `verify` attempts from JSON request/result paths under isolated per-mode runtime profiles.
- **`conductor`** — customer-side local daemon. Manages multiple Performer instances (`.conductor/instances/<id>/`), owns durable pipeline graph state, leases Podium dispatches, starts/stops per-mode Performers, and connects outbound to Podium as an enrolled runtime (`conductor_service.py`, `conductor_runtime.py`, `conductor_api.py`, `conductor_pipeline.py`).
- **`podium`** — SaaS control plane + BFF/static host. Owns auth, Linear OAuth/app state, runtime enrollment, dispatch queueing, webhooks, and the Linear proxy. `server.py` is a thin asyncio orchestrator over `auth_service.py`, `linear_service.py`, `runtime_service.py`, `onboarding_service.py`, and `store.py`.

### Import-boundary invariant (enforced by tests)

`tests/test_import_boundaries.py` fails the build if these are violated:

- `performer_api` must not import `performer`, `conductor`, or `podium`.
- `performer`, `conductor`, `podium` may import `performer_api`.
- `performer`, `conductor`, `podium` must **not** import each other.

Conductor is the only local process manager for Performer, and it launches it via the installed `performer` command (or repo-local fallback), never by importing Performer internals. When more than one role needs a contract, put it in `performer_api`.

### Managed dispatch flow

The runtime path is event-driven, not polling: a Linear issue is delegated to the Symphony custom agent → Linear sends an AgentSession webhook to Podium → Podium matches agent/project/runtime-group and queues a dispatch → Conductor leases it over outbound runtime auth → Conductor commits or resumes a durable `plan -> execute -> verify` graph → Performer runs one fenced `--mode plan|execute|verify` attempt. Dispatch routing is by custom-agent delegate, project scope, active state, blockers, verified graph dependencies, and runtime capacity — never labels or human assignee.

### Podium web frontend

`packages/podium/web/` is a Vite + React + TS SPA, built into `packages/podium/src/podium/static/` (committed so Podium serves the UI out of the box). Podium is BFF + static host in one service. Hard invariant: **Linear access/refresh tokens, session cookies, passwords, and client secrets never reach browser responses** — tokens are injected server-side into outbound `Authorization` headers only.

```bash
cd packages/podium/web
npm run dev          # Vite dev server
npm run build        # tsc -b && vite build (output goes to the committed static dir)
npm run test         # vitest run
npm run lint         # eslint . --max-warnings 0
npm run design:lint  # lint DESIGN.md against the @google/design.md spec
```

**Before making any UI change, read `packages/podium/web/DESIGN.md` and follow it.** Its YAML tokens are normative and mirror the CSS custom properties in `src/styles/tokens.css` (`--color-*`, `--space-*`, `--radius-*`, `--font-*`); consume those variables rather than hardcoding hex/px/radii. If a needed value isn't a token, add it to DESIGN.md and `tokens.css` first, then keep `npm run design:lint` clean (0 errors/0 warnings).

## Conventions

- This is a hard break from the old `symphony` package/CLI — do not add compatibility shims for old `symphony` imports, commands, labels, or state/log files unless explicitly asked.
- The runtime architecture source of truth is split across `docs/product/runtime-pipeline.md`, `docs/product/pipeline-state.md`, `docs/product/gates-verification-integration.md`, `docs/product/linear-projection.md`, and `docs/product/runtime-profiles-backends.md`. Do not add legacy scheduling or legacy workflow execution instructions.
- Secrets flow through `$VAR` indirection (e.g. `$PODIUM_PROXY_TOKEN`); values are validated but never printed in responses, logs, or API output.
- Prefer small role-owned modules over large cross-role files, and use the existing structured models/parsers instead of ad hoc string manipulation for workflow config, persisted state, ops snapshots, and Linear data.
