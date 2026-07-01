# Symphony

Symphony is one orchestration system for running coding agents as an "orchestra":

- **Podium** is the SaaS-facing web boundary. In this refactor it is intentionally small and starts with Conductor registration.
- **Conductor** is the local daemon, reporting hub, and operator control plane. It owns local instance metadata, starts and stops Performers, reads their state/events, and reports upstream to Podium.
- **Performer** is the execution worker. A Conductor can manage multiple Performer instances, each polling work and running Codex sessions for assigned tasks.
- **performer-api** contains the shared contracts that let those roles speak the same language without cross-importing each other's runtime code.

The repository is still named `symphony` because the product is the whole orchestra. The old `symphony` Python package and `symphony` CLI have been removed; runtime execution now uses the `performer`, `conductor`, and `podium` commands.

Performer implements the worker portion of `docs.md` with Linear as the issue tracker and Codex app-server as the coding-agent runner. A Performer:

1. Polls Linear for candidate issues in configured active states.
2. Creates or reuses one workspace per issue identifier.
3. Renders the issue prompt from `WORKFLOW.md`.
4. Runs Codex app-server in the issue workspace.
5. Tracks running sessions, retries, stall detection, terminal cleanup, and workflow reloads.

The default tracker is Linear. Performer also exposes a small tracker adapter registry for non-Linear integrations. In normal operation, you run Performer through Conductor so the local daemon can operate it and collect status/events centrally.

## Install

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e packages/performer-api -e packages/performer[test] -e packages/conductor -e packages/podium
```

## Configure

Edit `WORKFLOW.md` and set:

```bash
export LINEAR_API_KEY=...
```

`tracker.api_key` may be a literal token or an environment reference such as `$LINEAR_API_KEY`.
Set `tracker.assignee_id` when this worker should only process issues assigned to one Linear user.
Configured labels, active states, project slug, assignee, blockers, and concurrency all participate in dispatch eligibility.

## Run Performer Directly

```bash
make dev
```

Equivalent direct command:

```bash
.venv/bin/performer WORKFLOW.md
```

For a single poll cycle:

```bash
make once
```

## Conductor

`Conductor` is the host-local daemon/control plane for the Symphony runtime. It manages multiple Performer instances, persists per-instance metadata under `.conductor/instances/<id>/`, generates and validates managed `WORKFLOW.md` files, starts and stops Performer processes, reads Performer state/events from persisted state and ops files, and exposes a JSON API for instance CRUD, workflow operations, runtime controls, logs, repo inspection, and Podium registration/reporting.

Conductor does not ship a local web console in this build. It is the daemon/API layer that operates Performers and reports their state upward to Podium.

Run it with:

```bash
.venv/bin/conductor --port 8081 --data-root ./.conductor
```

Current API surface includes:

- `GET /`
- `GET /api/instances`
- `POST /api/instances`
- `GET /api/instances/:id`
- `PATCH /api/instances/:id`
- `DELETE /api/instances/:id`
- `POST /api/instances/:id/generate-workflow`
- `POST /api/instances/:id/validate-workflow`
- `POST /api/instances/:id/start`
- `POST /api/instances/:id/stop`
- `POST /api/instances/:id/restart`
- `GET /api/instances/:id/logs`
- `GET /api/instances/:id/runtime`
- `GET /api/issues`
- `GET /api/runs`
- `GET /api/traces`
- `POST /api/repo/inspect`
- `GET /api/settings`
- `PATCH /api/settings`
- `POST /api/podium/register`
- `GET /api/templates/workflow-profiles`

## Podium

`Podium` is the SaaS boundary for the Symphony system. This refactor only adds the first placeholder HTTP surface:

- `GET /`
- `GET /api/v1/health`
- `POST /api/v1/conductors/register`

Run it with:

```bash
.venv/bin/podium --port 8090
```

When `podium_url` is configured in Conductor settings, Conductor can explicitly register itself with Podium. When it is unset, registration is a no-op and local Performer orchestration still works.

This build supports `local_path` repository sources for instance creation and repo inspection. On create, Conductor initializes an instance-level repository workspace once when the managed workspace is empty, then reuses that workspace for future runs. The Git clone flow is still a stub and returns a structured API error.

To persist retry timers and running session metadata across daemon restarts:

```yaml
persistence:
  path: ./state/performer.json
```

Persistence stores scheduler metadata only. It does not serialize live processes or asyncio tasks; running sessions are retained as metadata for operators, while retry entries are restored with monotonic due times recalculated from their wall-clock `due_at`.

## Smoke Test Workflow

`WORKFLOW.smoke.md` is an isolated local smoke profile. It is pinned to the test Linear project used during manual validation, syncs this repository into `./workspaces`, limits Codex to one turn, and asks the worker to create `PERFORMER_SMOKE_RESULT.md`.

Use `WORKFLOW.md` for normal operation.

## Codex Permissions

The spec treats `codex.approval_policy`, `codex.thread_sandbox`, and `codex.turn_sandbox_policy` as Codex pass-through values. This implementation leaves them unset by default so the installed Codex app-server/config decides the effective policy. Set them explicitly in `WORKFLOW.md` if your deployment needs a specific trust posture.

Runtime confirmation policy:

- Command execution approval requests are approved for the session.
- File-change approval requests are accepted for the session.
- User-input requests fail the run instead of waiting indefinitely.
- Unsupported dynamic tool calls return a structured protocol error and the session continues.
- The `linear_graphql` client-side tool is available to Codex sessions and uses the configured Linear endpoint and token. It can read or mutate Linear depending on the GraphQL operation the workflow prompt asks the agent to run.

`LinearTracker` also has first-class `comment_issue(issue_id, body)` and `transition_issue(issue_id, state_id)` APIs for integrations that want direct tracker writes without going through the agent tool path.

## Workspace and Safety Posture

This implementation targets a trusted local automation environment. Managed Conductor instances use one prepared repository workspace per instance and rely on Codex/worktree behavior for per-task working state. Performer still validates that the configured workspace stays inside its managed root and honors the configured Codex approval/sandbox posture.

Workspace population is hook-based. `after_create`, `before_run`, `after_run`, and `before_remove` are trusted shell scripts from `WORKFLOW.md`; they run with the workspace directory as `cwd` and are protected by `hooks.timeout_ms`.

Secrets should be provided through `$VAR` indirection such as `$LINEAR_API_KEY`. Performer validates that required secrets are present but does not print token values. Hook scripts and agent prompts are trusted inputs and can still leak data if they are written unsafely.

The `linear_graphql` tool intentionally gives the agent access to configured Linear auth. Narrow dispatch scope with project slug, labels, assignee, and active states when running against shared workspaces.

## Extensions

The following `docs.md` extensions are shipped:

- `linear_graphql` client-side tool for Codex sessions when `tracker.kind: linear`.
- JSON persistence for retry queue and running session metadata.
- First-class Linear comment and state transition APIs.
- Pluggable tracker adapter registry via `performer.tracker.register_tracker_adapter()`.
- Appendix A SSH worker execution.

SSH worker configuration:

```yaml
worker:
  ssh_hosts:
    - builder-1
    - builder-2
  max_concurrent_agents_per_host: 1
```

When `worker.ssh_hosts` is omitted, work runs locally. When configured, Performer assigns each worker run to an available host and launches the Codex app-server as `ssh <host> 'cd <workspace_path> && <codex.command>'`. If all SSH hosts are saturated, dispatch waits instead of falling back to local execution. Remote hosts must already provide the expected shell, workspace path, Codex command, repository contents, and credentials.

## Tests

```bash
make test
```

Real Linear integration checks are skipped by default. To run the non-mutating profile:

```bash
PERFORMER_REAL_INTEGRATION=1 LINEAR_API_KEY=... PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src .venv/bin/python -m pytest tests/test_real_integration.py -q
```
