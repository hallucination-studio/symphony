# Symphony

Symphony is one orchestration system for running coding agents as an
"orchestra":

- **Podium** is the managed SaaS control plane. It owns auth, Linear OAuth/app
  state, runtime enrollment, dispatch queueing, runtime config, Podium Web, and
  the Linear proxy.
- **Conductor** is the customer-side daemon. It connects outbound to Podium,
  binds one Linear project and repository, leases dispatches, owns durable
  Managed Runs state, starts Performer turns, and reports local state. Multiple
  isolated Conductors may run on the same host for different projects.
- **Performer** is the execution worker. It runs one fenced managed-run turn from
  Conductor-owned request/result JSON paths.
- **performer-api** contains the shared contracts that let those roles exchange
  state without importing each other's runtime code.

The repository is named `symphony` because the product is the whole system. The
old `symphony` Python package and CLI have been removed; runtime execution uses
the `performer`, `conductor`, and `podium` commands.

## Architecture Docs

Start with [docs/product/README.md](docs/product/README.md). The runtime source
of truth is split by concern:

- [Managed Run Runtime](docs/product/runtime-pipeline.md)
- [Managed Run State](docs/product/pipeline-state.md)
- [Gates, Verification, And Integration](docs/product/gates-verification-integration.md)
- [Linear Projection](docs/product/linear-projection.md)
- [Runtime Profiles And Backends](docs/product/runtime-profiles-backends.md)
- [Linear Integration](docs/product/linear-integration.md)
- [Podium Web](docs/product/podium-web.md)
- [Runtime Installation](docs/product/runtime-installation.md)
- [Security Model](docs/product/security-model.md)
- [Real Run Testing Guide](docs/real-run-testing-guide.md)

## Runtime Flow

Managed execution is a Conductor-owned Linear-native managed run:

1. A Linear issue is delegated to the Symphony custom agent.
2. Podium receives a signed AgentSession webhook; project-scoped reconciliation
   polling covers missed deliveries with the same idempotency key.
3. Podium routes by the active installation and the project's unique Conductor
   binding, then queues one dispatch.
4. The project Conductor leases the dispatch over outbound runtime auth.
5. Conductor commits or resumes one durable managed run for the parent issue.
6. Performer runs plan or work-item turns under the Managed Runs contract.
7. Conductor verifies work-item results, records checkpoints, and
   projects sanitized state to Podium and Linear.

Dispatch routing is based on Linear organization, stable project id, installed
app user, selected scope, single-project Conductor binding, active state,
blockers, work-item dependencies, and runtime capacity. Project labels and
human assignee are not Managed Runs truth.

## Install

```bash
make install
```

Equivalent editable install:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e packages/performer-api -e packages/performer[test] -e packages/conductor -e packages/podium
```

## Test

```bash
make test
```

Focused tests need all package `src/` paths on `PYTHONPATH`:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_product_docs_pipeline.py -q
```

Real Linear integration runs also pin repo source roots:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src .venv/bin/python tools/real_symphony_e2e.py --project-slug <linear-project-slug> --managed-run-gates --timeout 600
```

## Run Conductor

```bash
make dev
```

Equivalent direct command:

```bash
.venv/bin/conductor --port 8081 --data-root ./.conductor
```

## Run Podium

```bash
export PODIUM_DATABASE_URL=postgresql://podium@localhost/podium
.venv/bin/podium api --host 127.0.0.1 --port 8090
```

## Run Performer Turn

Performer accepts only managed one-shot turns:

```bash
.venv/bin/performer \
  --turn-request-path /path/to/turn-request.json \
  --turn-result-path /path/to/turn-result.json
```

A Performer reads a fenced turn request, runs the requested managed-run role under
the prepared runtime profile, writes a fenced turn result, and exits. It never
leases dispatches, queries Linear as scheduler truth, or owns durable managed-run
state.

## Podium API Surface

Managed Podium endpoints include:

- `GET /api/v1/health`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `POST /api/v1/runtime/enrollment-tokens`
- `POST /api/v1/runtime/enroll`
- `GET /api/v1/runtime/ws`
- `POST /api/v1/runtime/dispatches/lease`
- `POST /api/v1/runtime/dispatches/ack`
- `POST /api/v1/runtime/config`
- `GET /api/v1/runtime/config`
- `GET /api/v1/managed-runs`
- `POST /api/v1/linear/graphql`

## Conductor API Surface

Managed Conductor endpoints include:

- `GET /api/instances`
- `POST /api/instances`
- `GET /api/instances/:id`
- `PATCH /api/instances/:id`
- `DELETE /api/instances/:id`
- `POST /api/instances/:id/start`
- `POST /api/instances/:id/stop`
- `POST /api/instances/:id/restart`
- `GET /api/instances/:id/logs`
- `GET /api/instances/:id/runtime`
- `GET /api/managed-runs`
- `POST /api/repo/inspect`
- `GET /api/settings`
- `PATCH /api/settings`

## Runtime Config

Podium pushes versioned managed-run policy and per-role runtime profiles to
Conductor. Conductor materializes isolated runtime homes under managed instance
state and fails closed if a required role profile is missing.

Codex-backed profiles receive isolated `CODEX_HOME` directories. The default
`verify` profile may use `local-verifier`, which runs frozen gate commands in a
disposable worktree with mutation detection after gate execution. That is not
OS-level read-only enforcement.

Secrets flow through `$VAR` indirection such as `$PODIUM_PROXY_TOKEN`. Values are
validated but never printed in responses, logs, result payloads, or browser API
responses. Linear access flows through Podium's server-side proxy.
