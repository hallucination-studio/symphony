# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

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
  .venv/bin/python -m pytest tests/conductor_pipeline -q
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

### Error visibility invariant

Do not hide runtime defects, failed attempts, backend setup errors, verifier failures, integration conflicts, webhook/proxy failures, or E2E harness failures. A failure is not handled unless it is visible in the right product surface and in test evidence.

- Product code must fail closed **and** make the reason observable. If Conductor, Performer, or Podium catches an exception, the sanitized reason must be recorded in durable state, surfaced through the relevant API/view, and written to an operator-visible log plus the relevant Linear wait surface when human action is required.
- Do not swallow exceptions with empty `except`, silent retries, indefinite polling, or generic `"failed"` states. Retries must preserve the latest sanitized error, retry count, and next action. Terminal failures must have a concrete reason such as `managed_codex_home_required`, `stale_fencing_token`, `gate_failed`, or `LINEAR_SYNC_CONFLICT`.
- E2E and real-run tools must print or record obvious failures immediately. If a pipeline attempt fails, a node enters `AWAITING_HUMAN` due to backend/runtime setup, a proxy call times out, or a required artifact is missing, the tool must emit a failing check with the concrete reason and write artifacts before continuing or exiting. Waiting until a global timeout while the underlying error is already known is a test bug.
- Browser/API responses and Podium pipeline views must stay sanitized, but sanitization must not erase the existence, category, or actionable summary of an error. Never expose secrets, tokens, cookies, passwords, raw profile secrets, or Linear tokens.
- Linear comments used by tests must be explicit about intent. Pipeline `need_human` resumes happen through node state flips; runtime wait resumes happen through their recorded runtime wait channel. Negative probes or diagnostic comments must identify themselves as such and must not look like business instructions.
- Tests should assert error visibility, not just error handling. When adding failure-path behavior, include coverage that the error appears in the pipeline view/report/log/evidence surface that an operator or acceptance run would actually inspect.

### Logging design invariant

Logs are a product surface for operators and acceptance runs, not a best-effort debug dump. Any runtime orchestration change must preserve clear, correlated, sanitized logs across Podium, Conductor, and Performer.

- Use structured, single-line log events. Prefer `event=<name> key=value ...` or JSON where the surrounding logger already uses JSON. Free-form prose is allowed only in a `message` or `summary` field.
- Every orchestration log must include the IDs needed to join it to durable state when those IDs exist: `runtime_group_id`, `runtime_id` or `conductor_id`, `instance_id`, `graph_id`, `node_id`, `attempt_id`, `mode`, `lease_id`, `fencing_token`, `issue_id`/`issue_identifier`, `policy_revision`, `graph_revision`, `result_path`, `request_path`, and `linear_projection_id`.
- Event names are stable API-adjacent vocabulary. Use lower-snake-case names prefixed by subsystem when useful, for example `podium_dispatch_queued`, `conductor_dispatch_leased`, `pipeline_graph_committed`, `pipeline_attempt_started`, `performer_backend_invoked`, `pipeline_result_collected`, `pipeline_human_wait_created`, and `linear_projection_updated`.
- Log lifecycle transitions at `info`: webhook accepted/rejected, dispatch queued/leased/acked, runtime config accepted/rejected, graph committed/revised, node became ready, attempt requested/started/heartbeat/completed, lease heartbeat/reclaim, result file detected/collected/applied, manifest published, integration queued/completed/conflicted, Linear projection created/updated, human wait created/resolved, and process start/exit.
- Log progress heartbeats at `info` often enough that a real run never appears dead for more than one minute. A running attempt should show either a fresh lease heartbeat, process heartbeat, backend progress event, result collection event, or durable state transition. If no stdout is expected from a backend, Conductor must still log that the attempt is alive and what it is waiting for.
- Log recoverable problems at `warning`: stale results, stale fencing tokens, retryable Podium/Linear proxy failures, missing optional artifacts, skipped dispatches with a concrete reason, config version rejection, backend capacity exhaustion, no eligible graph nodes, and ignored human-action signals with a concrete reason.
- Log terminal or human-action-causing failures at `error`: backend setup failure, missing per-mode profile, isolated `CODEX_HOME` materialization failure, Codex invocation failure, invalid planner JSON after retries, gate execution failure, verifier artifact/hash mismatch, integration conflict, unrecoverable Podium/Linear proxy failure, and any exception that changes graph/node/attempt state.
- Standard failure fields are `error_type`, `error_code`, `sanitized_reason`, `action_required`, `retryable`, `attempt_number`, and `next_action`. Do not emit only `failed=true`; the log must explain what failed and what the system did next.
- Never log secrets or raw credentials. Redact tokens, cookies, passwords, client secrets, raw runtime profile secrets, Authorization headers, and Linear tokens. Sanitization must keep the error category and actionable summary intact; `[REDACTED]` is acceptable for secret values, not for the entire error.
- Real-run Codex configuration must be injected from a fixed, staged copy created for that E2E run. The E2E runner must not default to or accept `~/.codex` as a runtime input. If local Codex credentials are needed, copy only the approved seed files (`config.toml`, `auth.json`, `version.json`, `models_cache.json`) into a fixed seed directory first, set `SYMPHONY_E2E_CODEX_HOME_SEED` to that copied directory, and let the runner stage another per-run copy from there. Podium runtime config, Conductor runtime profiles, logs, reports, and evidence artifacts must not directly reference or expose `~/.codex` or link to a directory containing `auth.json`.
- Do not rely on stdout only. Performer stdout/stderr must be captured into the instance log generation with stream labels and attempt correlation. Conductor must also persist scheduler/backend failures that happen before a Performer process starts. Podium must log webhook/proxy/config/report failures with correlation IDs.
- Linear is an operator-visible surface during managed E2E. When Symphony takes ownership of a delegated issue, creates a graph, starts an attempt, waits on Codex approval/tool input, blocks on human action, or hits an integration conflict, the Linear projection, node-level `need_human`, or runtime wait child issue must make that state visible without requiring local log access. Do not spam per-line backend output into Linear.
- Logs must not be the only source of truth. Every logged terminal failure must also appear in durable pipeline state and the relevant API/report view. Conversely, any durable terminal failure should have a corresponding log event unless logging itself failed.
- Real-run tools must archive relevant logs as artifacts on early exit or failure: Podium log, Conductor log, per-instance Performer logs, pipeline view/report JSON, attempt request/result JSON, and Linear projection evidence. A real E2E report with a failure count but no linked runtime logs is incomplete evidence.
- Tests must cover log visibility for new failure paths. Prefer assertions on event name, correlation IDs, sanitized reason, and durable-state/API parity over brittle full-line string comparisons.
- Anti-patterns: empty `except` blocks, background tasks that only fail in debug logs, retry loops with no visible counter or last error, "waiting" output with no correlation ID, multiline unstructured tracebacks as the only record, printing secrets before redaction, hiding subprocess stdout/stderr in memory, and tests that pass after a known failure is only visible by manually inspecting a temp directory.

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
- The runtime architecture source of truth is split across `docs/product/runtime-pipeline.md`, `docs/product/pipeline-state.md`, `docs/product/gates-verification-integration.md`, `docs/product/linear-projection.md`, and `docs/product/runtime-profiles-backends.md`. Do not add legacy scheduling or `WORKFLOW.md` execution instructions.
- Runtime approval, permission, and tool-input waits must be projected to Linear as runtime wait state and as node metadata (`operator_status: waiting_for_runtime_input`, `operator_wait_kind`, and a Runtime Wait block), including `[Human Action]` child issues when that wait flow uses them. Local stdout/logs alone are not an acceptable operator signal.
- Secrets flow through `$VAR` indirection (e.g. `$PODIUM_PROXY_TOKEN`); values are validated but never printed in responses, logs, or API output.
- Prefer small role-owned modules over large cross-role files, and use the existing structured models/parsers instead of ad hoc string manipulation for workflow config, persisted state, ops snapshots, and Linear data.
