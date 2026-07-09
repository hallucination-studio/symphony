# Real Run Testing Guide

This guide defines how to test Symphony's managed pipeline as a running system,
not as a collection of mocks.

Use it when validating pipeline graph behavior, Linear projection, Codex
execution, Conductor runtime, verified manifests, integration, human waits, or
any behavior where unit tests can pass while the product still fails
operationally.

## Core Rule

A real run test must start the local product and let Conductor own the durable
pipeline graph while Performer executes exactly one fenced `plan`, `execute`, or
`verify` attempt at a time.

The harness may:

- clean the test Linear project before and after a scenario;
- start a Conductor instance;
- create the initial business issue;
- observe Linear, logs, pipeline store state, and Podium reports;
- stop the Conductor instance after the scenario.

The harness must not:

- fake Codex when the scenario says "real Codex";
- transition graph nodes, integration queue entries, or human waits by hand;
- create gate, graph-node, manifest, or human-action projection issues by hand;
- manually complete parent issue comments or command comments as control signals;
- call private methods to advance pipeline state;
- treat mock-only success as acceptance evidence.

## Reusable Tools

### Audit Or Archive A Linear Test Project

Use the generic project issue tool instead of rewriting one-off cleanup scripts.

```bash
set -a && source .env && set +a
PYTHONPATH=src python3 tools/linear_project_issues.py audit \
  --project HELL \
  --out .test-real-flow/evidence/hell-audit-before.json
```

Archive all active unarchived issues in the project:

```bash
set -a && source .env && set +a
PYTHONPATH=src python3 tools/linear_project_issues.py archive \
  --project HELL \
  --out .test-real-flow/evidence/hell-archive-before-run.json
```

Archive only issues from one run label family:

```bash
set -a && source .env && set +a
PYTHONPATH=src python3 tools/linear_project_issues.py archive \
  --project HELL \
  --label-prefix performer-real-codex- \
  --out .test-real-flow/evidence/hell-archive-real-codex.json
```

Expected cleanup evidence for a clean test start is `after_count: 0`.

## Real Scenario Shape

Use this order for end-to-end validation:

1. Archive or audit the test project.
2. Create and start a Conductor instance for the current repo.
3. Ensure the instance has runtime profiles for all three modes.
4. Create one Linear business issue with a unique run label or delegated agent session.
5. Let Podium dispatch the issue to Conductor.
6. Let Conductor commit a root planning node, lease `plan`, `execute`, and
   `verify` attempts, publish a verified manifest, integrate the patch, and
   project graph state back to Linear.
7. Observe until integration completes, a human wait is created, or a clear
   stall is reached.
8. Save evidence.
9. Stop Conductor.
10. Archive or audit the test project again.

The ordering matters. Starting Conductor before creating the issue proves
dispatch happens through the product. Creating the issue first and then manually
running attempts can hide scheduling bugs.

## Required Evidence

A real run evidence bundle should include:

- Conductor instance id, log path, runtime profile summary, and process status after stop.
- Business issue id, identifier, URL, state, labels, and projected metadata.
- Pipeline graph revision, policy revision, node states, blockers, and gate snapshot hashes.
- Attempt records with mode, lease id, fencing token, graph revision, policy revision, status, and sanitized error.
- Verification input snapshots, verifier score, and frozen gate procedure output.
- Task output manifest, integration queue status, integrated revision or conflict error.
- Human waits on the affected pipeline node, including the need_human workflow state,
  instruction comment, and state-flip resume evidence when applicable.
- Podium pipeline report/API payload with sanitized runtime config.
- Performer log excerpts around plan, execute, verify, manifest publication, integration, rework, replan, and human wait.
- Cleanup audit after the run.

For pipeline acceptance, success requires:

- the delegated issue creates or resumes a root planning node;
- every executable node is bound to a frozen gate snapshot;
- downstream nodes start only after blockers verify pass with score `>= 3`;
- verifier runs in an isolated workspace against the executor patch and frozen gate;
- verify pass publishes a verified-but-unintegrated manifest before integration;
- integration success records the integrated revision, or conflict creates a pipeline human wait;
- Linear projection includes `graph_id`, `node_id`, `plan_attempt_id`, `gate_snapshot_hash`, `conductor_revision`, and `operator_status`.
- Runtime approval/permission/tool-input waits appear in the Linear projection with `operator_status: waiting_for_runtime_input`, `operator_wait_kind`, and a Runtime Wait detail block.

## Stall Diagnosis

Do not keep waiting if the system is clearly stuck. Stop and inspect.

Useful read-only checks:

```bash
ps -ef | rg 'performer|conductor|codex app-server' | rg -v rg
tail -200 /path/to/instances/inst-1/logs/performer.log
python3 -m json.tool /path/to/instances/inst-1/state/performer.json
python3 -m json.tool /path/to/instances/inst-1/state/ops.json
```

Read-only Linear tree inspection should include explicit parent fields:

```graphql
issue(id: $issueId) {
  id
  identifier
  state { name }
  labels { nodes { name } }
  children(first: 50) {
    nodes {
      id
      identifier
      parent { id identifier }
      state { name }
      labels { nodes { name } }
      children(first: 50) {
        nodes {
          id
          identifier
          parent { id identifier }
          state { name }
          labels { nodes { name } }
        }
      }
    }
  }
}
```

Common real-run failure signatures:

- active lease exists but no matching Performer process or heartbeat updates.
- attempt result is written but rejected because graph revision, policy revision, gate hash, lease id, or fencing token does not match.
- downstream node starts while a blocker lacks `VERIFY_PASSED` with score `>= 3`.
- manifest exists but integration queue never completes.
- Linear projection lacks graph metadata or shows a stale conductor revision.
- a human-action scenario resumes from a comment alone: this is invalid. Conductor resumes only from the affected node issue being moved out of the need_human/blocked workflow state.

## Human Action Flow

Any real-run scenario that needs human judgment must validate the in-place node issue flow:

1. The pipeline node issue enters the need_human/blocked workflow state and records the wait reason.
2. Conductor posts one durable `comment_id`-replayed instruction comment on that node explaining the structured reason, what information to provide, and how to resume.
3. The human adds any required context as comments on that same node issue.
4. The human moves that node issue out of the need_human/blocked workflow state.
5. Performer resumes only from the state flip. Comments, including command-like comments, are informational only and do not count as acceptance evidence.

For input requests, the node issue comments must contain the answer. A comment without the state flip must not resume the task.

## Codex Requirements

When the test says real Codex, the process must launch real `codex app-server`. A deterministic fake app-server is useful for local protocol or pipeline contract scenarios, but it is not valid evidence for real acceptance.

Real E2E must inject Codex configuration from a fixed copied seed directory, not from the operator's default Codex home. Set `SYMPHONY_E2E_CODEX_HOME_SEED` to a prepared directory containing only approved seed files (`config.toml`, `auth.json`, and optionally `version.json` / `models_cache.json`). The harness stages another per-run copy from that seed before pushing runtime config.

For long real turns:

- keep `read_timeout_ms` finite;
- allow `turn_timeout_ms <= 0` when the scenario needs no hard total turn deadline;
- use `stall_timeout_ms` as the no-event timeout;
- ensure long tool runs emit events or heartbeats often enough to avoid stall kills.

## Retry, Rework, And Replan

Use these terms consistently:

- `retry`: a failed or timed-out fenced attempt in the same stage can be rerun under a fresh lease, bounded by the retry counter.
- `need_human`: same-stage retry exhaustion or an operator-required condition blocks the affected node in place until a state flip resumes it.
- `replan`: a verifier judgment that the approach is wrong invokes planning with failure context and replaces the failed node with a validated superseding node/subgraph revision.

Evidence should show:

- attempts are fenced by graph revision, policy revision, lease id, and gate hash;
- retry increments the node retry count without replacing the graph revision;
- replan creates a new immutable graph revision and supersedes the failed node, preserving inherited block edges.

## Minimum Local Verification

Before a real run, execute the focused local tests for the area under change. After fixes from a real run, execute the full suite.

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_pipeline_contracts.py tests/test_conductor_pipeline.py tests/test_performer_modes.py tests/test_podium_pipeline.py -q
make test
```

Passing local tests is necessary but not sufficient. For orchestration changes, the real run evidence decides whether the behavior works operationally.

## Podium Web To Linear Acceptance

Use this scenario when changing Podium onboarding, auth/session behavior, runtime enrollment, Conductor reporting, PostgreSQL-backed runtime state, dispatch routing, WebSocket wakeups, log streaming, or any code where a browser-created Conductor must receive real Linear work.

This is the required full-flow acceptance path:

1. Start Podium from the repo with real Linear credentials available to Podium:

   ```bash
   set -a && source .env && set +a
   # Required for delegate polling and Symphony-authored comments, child issues,
   # activities, and workflow transitions.
   # Must be a Linear OAuth token authorized with actor=app and scopes:
   # read,write,app:assignable,app:mentionable. Do not use a human/operator API key.
   export PODIUM_LINEAR_APPLICATION_ID="$YOUR_LINEAR_APP_USER_ID"
   export PODIUM_LINEAR_APP_ACCESS_TOKEN="$YOUR_LINEAR_APP_ACTOR_TOKEN"
   export PODIUM_LINEAR_POLL_INTERVAL_SECONDS=1
   export PYTHONPATH="$PWD/packages/performer-api/src:$PWD/packages/performer/src:$PWD/packages/conductor/src:$PWD/packages/podium/src"
   .venv/bin/podium --host 127.0.0.1 --port 8090
   ```

2. Start Podium Web and verify the onboarding surface in Chrome MCP or an equivalent real browser session:

   ```bash
   cd packages/podium/web
   npm run dev -- --host 127.0.0.1 --port 5174
   ```

3. From Podium Web, register or sign in, open onboarding, and create the runtime enrollment command. The command must come from Podium, not from a hand-written token.

   The API behind the UI is:

   ```text
   POST /api/v1/onboarding/runtime/enrollment-token
   ```

4. Run the install command locally exactly as a user would run it, with only test-specific paths and ports changed:

   ```bash
   PODIUM_CONDUCTOR_DATA_ROOT=/tmp/symphony-podium-e2e/conductor \
   PODIUM_CONDUCTOR_PORT=59120 \
   PODIUM_CONDUCTOR_COMMAND="$PWD/.venv/bin/conductor" \
   curl -fsSL http://127.0.0.1:8090/install.sh | bash -s -- \
     --podium-url http://127.0.0.1:8090 \
     --enrollment-token "$ENROLLMENT_TOKEN"
   ```

5. Verify the installed Conductor config before creating work:

   - `managed_mode=true`
   - `podium_runtime_token_configured=true`
   - `podium_proxy_token_configured=true`
   - `podium_ws_url=ws://127.0.0.1:8090/api/v1/runtime/ws`

6. Create a real local git fixture repo with a runnable smoke test, for example `tests/test_smoke.py`. The fixture must be a git repository; non-git directories are not valid acceptance evidence.

7. Create a Conductor instance for that repo. Configure it with:

   - the target Linear project id or slug;
   - `linear_agent_app_user_id=$PODIUM_LINEAR_APPLICATION_ID`;
   - a small pipeline goal with a frozen gate that makes one verifiable file change and runs `pytest tests/test_smoke.py -q`.

8. Force or wait for Conductor to report to Podium so the project binding, metrics, and log tail are visible from Podium. A direct local helper such as `ConductorService.post_podium_report()` is acceptable only for reporting local Conductor state upward; it must not fake dispatch, completion, or Linear state.

9. Create one real Linear issue delegated to the same agent app user. Do not inject dispatches or send synthetic events; wait for Podium's delegate poller to observe the issue through Linear GraphQL and enqueue the dispatch for the registered workspace/runtime binding.

10. Let the Conductor and Performer complete the issue. Do not manually move the issue, create comments, acknowledge dispatch rows, or write Podium run completion state.

11. Verify the browser-visible and backend-visible outcome:

   - Podium Web shows the enrolled runtime and pipeline state after a real browser refresh.
   - `/api/v1/pipeline` for the logged-in user shows the graph revision, mode capacity, attempts, manifests, and terminal integration state.
   - The Performer log shows the target issue was handled through Podium dispatch, not a broad project scan.
   - The expected file exists with exact content from the pipeline goal.
   - An independent `pytest tests/test_smoke.py -q` passes inside the fixture repo.
   - The Linear issue has the expected handoff/comment evidence and no false failed/verifier labels on a successful run.
   - The Conductor acknowledged completion back to Podium after Performer completion.

### Podium Full-Flow Evidence

Capture enough evidence for another agent to distinguish a true product run from a hand-wired script:

- Podium backend command, port, env names used, and log excerpt around registration, report, delegate polling, dispatch, and completion.
- Podium Web URL plus Chrome MCP screenshot or snapshot of onboarding/runtime/pipeline when UI behavior is in scope.
- Registered Podium user/workspace id and runtime binding used by the poller.
- Enrollment token creation evidence without printing secret token values.
- Installed Conductor config summary with secret values redacted.
- Conductor instance id, data root, repo path, pipeline graph id/revision, and log path.
- Linear issue id, identifier, URL, delegate/app user id, state, labels, and relevant comments.
- Podium `/api/v1/pipeline` response summary for the logged-in session.
- Fixture repo `git status`, changed file path/content, and smoke test output.

### Podium Full-Flow Failure Signatures

Watch these known failures explicitly:

- Missing `PODIUM_LINEAR_APP_ACCESS_TOKEN`, or minting it without `app:assignable` and `app:mentionable`, causes Symphony-authored Linear mutations or custom-agent delegation to fail closed; do not substitute a human/operator API key.
- Missing `PODIUM_LINEAR_APPLICATION_ID` prevents the delegate poller from starting.
- Setting only `LINEAR_API_KEY` or `PODIUM_LINEAR_ACCESS_TOKEN` does not authorize the managed path.
- A fixture that is not a git repository, or lacks the smoke test referenced by the frozen gate, can produce verifier failures that do not prove the product path is broken.
- Event-driven one-shot work must continue the same `dispatch_issue_id` on retry or resume. It must not fall back to a daemon-wide project scan.
- Small one-file changes are valid completion evidence when the pipeline gate asks for exactly that; the verifier must not reject them only for being small.
- Completion is incomplete until Conductor posts the runtime completion acknowledgment and Podium marks the run terminal.
- A first Codex response that is structured as blocked may retry. That is acceptable only when the retry stays scoped to the same issue and dispatch.

### Podium Regression Tests

Run the focused tests for the touched area before the real scenario, then run the full suites after fixing real-run findings.

Important Podium and runtime tests:

- `tests/test_podium_runtime_onboarding.py::test_install_script_exists_and_uses_enrollment_token`
- `tests/test_conductor_podium_channels.py`
- `tests/test_podium_conductor_channels.py`
- `tests/test_no_podium_memory_state.py`
- `tests/test_podium_infra.py`
- `tests/test_podium_auth.py`
- `tests/test_podium_onboarding.py`
- `tests/test_podium_linear_polling.py`

Focused command:

```bash
PYTHONPATH=$PWD/packages/performer-api/src:$PWD/packages/performer/src:$PWD/packages/conductor/src:$PWD/packages/podium/src \
  .venv/bin/python -m pytest -q \
  tests/test_pipeline_contracts.py \
  tests/test_conductor_pipeline.py \
  tests/test_performer_modes.py \
  tests/test_podium_pipeline.py
```

Full verification:

```bash
make test
cd packages/podium/web && npm run test && npm run build
```

## When To Stop A Real Run

Stop and diagnose instead of waiting when one of these is true:

- the same `already_running_or_claimed` line repeats while no worker is running;
- Linear projection is unchanged across several report intervals after worker completion;
- graph-node or human-action projection structure is malformed;
- the business issue has contradictory graph metadata or stale conductor revision;
- logs show verification or integration failure and no later dispatch or human wait is possible;
- the run exceeds the scenario timeout.

Stopping a stuck run is not failure of the test process. It is a valid real acceptance finding. Fix the product bug, archive the test project, and rerun from a clean project.
