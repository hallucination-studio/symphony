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
- **Performer** is the execution worker and backend boundary. It runs fenced
  managed-run turns, exposes provider-neutral control operations, and owns the
  internal backend interface plus provider SDK adapters.
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
- [Module Design Baselines](docs/modules/README.md)
- [Real Flow](docs/real-flow.md)

## Runtime Flow

Managed execution is a Conductor-owned Linear-native managed run:

1. A Linear issue is delegated to the Symphony custom agent.
2. Podium's project-scoped poller discovers delegation through fully paginated
   baseline and incremental scans with transactional checkpoints.
3. Podium routes by the active installation and the project's unique Conductor
   binding, then queues one dispatch per delegation epoch.
4. The project Conductor leases the dispatch over outbound runtime auth.
5. Conductor commits or resumes one durable managed run for the parent issue.
6. Performer runs one plan, execute, or read-only gate turn under the compact
   workflow contract.
7. Conductor creates Linear Sub Issues, executes them strictly in order, runs
   verification commands plus one selected-backend Gate per task, and projects
   sanitized evidence to Podium and Linear.

Dispatch routing is based on Linear organization, stable project id, installed
app user, selected scope, single-project Conductor binding, active state,
and blockers. Project labels and human assignee are not workflow routing truth.

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
  .venv/bin/python -m pytest tests/test_minimal_performer_api.py tests/test_conductor_workflow.py tests/test_podium_runtime_polling.py -q
```

Real Linear integration runs load the staged environment and pin repo source roots:

```bash
set -a && source .env && set +a
PYTHONPATH=$(pwd)/tools .venv/bin/python tools/real_flow.py --phase all --project-slug "$SYMPHONY_E2E_PROJECT_SLUG" --out .test-real-flow/batch-report.json
```

The Performer phase copies only the approved staged seed files into one
isolated per-batch context, starts installed `performer control`, runs an
explicit manual Check, and then runs plan, execute, and gate through installed
one-shot Performer processes using that same context. The runner never imports
a provider SDK or reads the ambient `~/.codex` home.

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

A Performer reads a fenced turn request, selects an approved backend through
its internal registry, writes a fenced normalized result, and exits. It never
leases dispatches, queries Linear as scheduler truth, or owns durable
managed-run state.

Provider-neutral live control uses the installed control mode and a bounded
stdin/stdout protocol managed by Conductor:

```bash
.venv/bin/performer control
```

Provider SDKs, authentication/configuration behavior, Check execution, and
provider session handles remain inside Performer backend implementations.
Conductor imports only `performer_api` contracts.

## Podium API Surface

Managed Podium endpoints include:

- `GET /api/v1/health`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `POST /api/v1/runtime/enrollment-tokens`
- `POST /api/v1/runtime/enroll`
- `POST /api/v1/runtime/dispatches/lease`
- `POST /api/v1/runtime/dispatches/ack`
- `POST /api/v1/runtime/commands/lease`
- `POST /api/v1/runtime/commands/ack`
- `POST /api/v1/runtime/report`
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

## Runtime

Podium stores reusable `runtime_profile` rows plus a Symphony-owned
`performer_profile` wrapper. Profiles contain only secret-free execution/turn
policy and hashes; binding generation fences `project.configure` updates.

One Conductor selects one fixed allowlisted backend process context and starts
installed Performer control/turn processes. It persists generic readiness but
does not import `performer`, provider SDKs, or provider-generated types.
Performer owns the internal `PerformerBackend` interface, explicit closed
registry, policy-to-SDK mapping, login/config/Check behavior, response
validation, and sanitization. Codex is the first production adapter; another
provider requires a separately approved implementation.

Secret-bearing control operations use pipes and are never persisted as control
request/result files. The Web receives only normalized capabilities, profile,
generation/hash, policy, and readiness metadata. The execute turn works only
within the approved task scope, while the gate turn is read-only.
Verification commands run before the selected backend's read-only Performer
Gate and their evidence is stored with the task result.

Secrets flow through `$VAR` indirection such as `$PODIUM_PROXY_TOKEN`. Values are
validated but never printed in responses, logs, result payloads, or browser API
responses. Linear access flows through Podium's server-side proxy.
