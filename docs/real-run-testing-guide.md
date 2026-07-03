# Real Run Testing Guide

This guide defines how to test Performer as a running system, not as a collection of mocks.

Use it when validating orchestration behavior, Linear state transitions, Codex execution, Conductor runtime, acceptance gates, retry/continuation semantics, or any behavior where unit tests can pass while the product still fails operationally.

## Core Rule

A real run test must start the local product and let Performer own the workflow.

The harness may:

- clean the test Linear project before and after a scenario;
- start a Conductor instance;
- create the initial business issue;
- observe Linear, logs, persistence, and ops snapshots;
- stop the Conductor instance after the scenario.

The harness must not:

- fake Codex when the scenario says "real Codex";
- transition the business issue to `In Review` or `Done`;
- create gate or evidence issues by hand;
- manually add pass/fail gate labels;
- call private orchestrator methods to advance phases;
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
3. Patch only the instance workflow needed for the scenario.
4. Create one Linear business issue with a unique run label.
5. Let Performer perform planning, implementation dispatch, review, gate/evidence creation, and final transitions.
6. Observe until a terminal condition or a clear stall is reached.
7. Save evidence.
8. Stop Conductor.
9. Archive or audit the test project again.

The ordering matters. Starting Conductor before creating the issue proves dispatch happens through the product. Creating the issue first and then manually running phase scripts can hide scheduling bugs.

## Required Evidence

A real run evidence bundle should include:

- Conductor instance id, workflow path, log path, and process status after stop.
- Business issue id, identifier, URL, state, labels, and description evidence.
- Gate issues with `parent { id identifier }`.
- Evidence issues with `parent { id identifier }`.
- Runtime persistence snapshots:
  - `sessions`
  - `retry_attempts`
  - `continuations`
- Ops snapshot excerpts for runs, attempts, turns, and important events.
- Performer log excerpts around dispatch, worker completion, verification, gate review, fail/rework, pass/done, retry, and continuation.
- Cleanup audit after the run.

For gate-tree acceptance, success requires:

- the business issue is the root;
- each gate is a direct child with `performer:type/gate`;
- each evidence issue is a child of its gate with `performer:type/evidence`;
- no new default `[Acceptance]` sibling issue is created;
- no new default `blocks` relation is used as the primary acceptance mechanism;
- the business issue reaches `Done` only after all gates pass.

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

- `running=0 claimed=1` repeated in logs: a scheduler claim was not released.
- Business issue has `performer:phase/review` but Linear state is still `In Progress`: review phase and Linear workflow state diverged.
- Gate issues are siblings of the business issue: child creation is not using `parentId`.
- Evidence issues are siblings of gates: evidence creation is not using the gate as parent.
- Agent final answer says it did work, but business issue lacks `Implementation summary`, `Test commands and exact output`, and `Remaining risks`: do not enter review.
- Normal max-turn continuation appears under `retry_attempts`: continuation semantics regressed.

## Codex Requirements

When the test says real Codex, the process must launch real `codex app-server`. A deterministic fake app-server is useful for local protocol or gate-tree unit scenarios, but it is not valid evidence for real acceptance.

For long real turns:

- keep `read_timeout_ms` finite;
- allow `turn_timeout_ms <= 0` when the scenario needs no hard total turn deadline;
- use `stall_timeout_ms` as the no-event timeout;
- ensure long tool runs emit events or heartbeats often enough to avoid stall kills.

## Retry Versus Continuation

Use these terms consistently:

- `retry`: failure recovery after exception, timeout, stall, verification failure, or equivalent error.
- `continuation`: normal follow-up work after a resource boundary such as max turns while the issue remains active.

A continuation should appear as:

- `performer:continuing`;
- `continuations` in persisted runtime;
- `continuing` in snapshots and Conductor runtime.

It should not appear as:

- `performer:retrying`;
- an error-bearing `retry_attempts` row;
- a failure count in dashboards.

## Minimum Local Verification

Before a real run, execute the focused local tests for the area under change. After fixes from a real run, execute the full suite.

```bash
PYTHONPATH=src python3 -m pytest tests/test_orchestrator.py tests/test_linear.py tests/test_acceptance.py -q
PYTHONPATH=src python3 -m pytest -q
```

Passing local tests is necessary but not sufficient. For orchestration changes, the real run evidence decides whether the behavior works operationally.

## Podium Web To Linear Acceptance

Use this scenario when changing Podium onboarding, auth/session behavior, runtime enrollment, Conductor reporting, Redis/PG runtime state, dispatch routing, WebSocket wakeups, log streaming, or any code where a browser-created Conductor must receive real Linear work.

This is the required full-flow acceptance path:

1. Start Podium from the repo with real Linear credentials available to Podium:

   ```bash
   set -a && source .env && set +a
   export PODIUM_LINEAR_ACCESS_TOKEN="$LINEAR_API_KEY"
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
   - `linear_agent_app_user_id=$LINEAR_AGENT_APP_USER_ID`;
   - a small workflow goal that makes one verifiable file change and runs `pytest tests/test_smoke.py -q`.

8. Force or wait for Conductor to report to Podium so the project binding, metrics, and log tail are visible from Podium. A direct local helper such as `ConductorService.post_podium_report()` is acceptable only for reporting local Conductor state upward; it must not fake dispatch, completion, or Linear state.

9. Create one real Linear issue delegated to the same agent app user. Send the real Podium `AgentSessionEvent` webhook for the actual Podium workspace/user id returned by registration. Do not hardcode `user_1`; using the wrong workspace queues work for the wrong user and makes the current user's runs appear empty.

10. Let the Conductor and Performer complete the issue. Do not manually move the issue, create comments, acknowledge dispatch rows, or write Podium run completion state.

11. Verify the browser-visible and backend-visible outcome:

   - Podium Web shows the enrolled runtime and recent run state after a real browser refresh.
   - `/api/v1/runs/recent` for the logged-in user shows the dispatch and terminal status, normally `success`.
   - The Performer log shows the target issue was handled through event-driven dispatch, not a broad project scan.
   - The expected file exists with exact content from the workflow goal.
   - An independent `pytest tests/test_smoke.py -q` passes inside the fixture repo.
   - The Linear issue has the expected handoff/comment evidence and no false failed/verifier labels on a successful run.
   - The Conductor acknowledged completion back to Podium after Performer completion.

### Podium Full-Flow Evidence

Capture enough evidence for another agent to distinguish a true product run from a hand-wired script:

- Podium backend command, port, env names used, and log excerpt around registration, report, dispatch, and completion.
- Podium Web URL plus Chrome MCP screenshot or snapshot of onboarding/runtime/runs when UI behavior is in scope.
- Registered Podium user/workspace id used by the webhook.
- Enrollment token creation evidence without printing secret token values.
- Installed Conductor config summary with secret values redacted.
- Conductor instance id, data root, repo path, workflow path, and log path.
- Linear issue id, identifier, URL, delegate/app user id, state, labels, and relevant comments.
- Podium `/api/v1/runs/recent` response summary for the logged-in session.
- Fixture repo `git status`, changed file path/content, and smoke test output.

### Podium Full-Flow Failure Signatures

Watch these known failures explicitly:

- Missing `PODIUM_LINEAR_ACCESS_TOKEN` causes Podium Linear proxy requests to fail even when `LINEAR_API_KEY` is set.
- A webhook with the wrong Podium workspace/user id creates a valid dispatch for another user; the current user's run list remains empty.
- A fixture that is not a git repository, or lacks the smoke test referenced by the workflow, can produce verifier failures that do not prove the product path is broken.
- Event-driven one-shot work must continue the same `dispatch_issue_id` on retry or resume. It must not fall back to a daemon-wide project scan.
- Small one-file changes are valid completion evidence when the workflow asks for exactly that; the verifier must not reject them only for being small.
- Completion is incomplete until Conductor posts the runtime completion acknowledgment and Podium marks the run terminal.
- A first Codex response that is structured as blocked may retry. That is acceptable only when the retry stays scoped to the same issue and dispatch.

### Podium Regression Tests

Run the focused tests for the touched area before the real scenario, then run the full suites after fixing real-run findings.

Important Podium and runtime tests:

- `tests/test_podium_runtime_onboarding.py::test_install_script_exists_and_uses_enrollment_token`
- `tests/test_conductor_podium_channels.py`
- `tests/test_podium_conductor_channels.py`
- `tests/test_completion_verifier.py`
- `tests/test_no_podium_memory_state.py`
- `tests/test_podium_infra.py`
- `tests/test_podium_auth.py`
- `tests/test_podium_onboarding.py`
- `tests/test_podium.py::test_agent_session_webhook_queues_only_delegated_custom_agent_dispatch_and_runtime_acks`

Focused command:

```bash
PYTHONPATH=$PWD/packages/performer-api/src:$PWD/packages/performer/src:$PWD/packages/conductor/src:$PWD/packages/podium/src \
  .venv/bin/python -m pytest -q \
  tests/test_completion_verifier.py \
  tests/test_conductor_podium_channels.py \
  tests/test_podium_runtime_onboarding.py \
  tests/test_podium.py::test_agent_session_webhook_queues_only_delegated_custom_agent_dispatch_and_runtime_acks
```

Full verification:

```bash
make test
cd packages/podium/web && npm run test && npm run build
```

## When To Stop A Real Run

Stop and diagnose instead of waiting when one of these is true:

- the same `already_running_or_claimed` line repeats while no worker is running;
- Linear tree state is unchanged across several polling intervals after worker completion;
- gate/evidence structure is malformed;
- the business issue has contradictory state/phase labels;
- logs show verification/gate failure and no later dispatch is possible;
- the run exceeds the scenario timeout.

Stopping a stuck run is not failure of the test process. It is a valid real acceptance finding. Fix the product bug, archive the test project, and rerun from a clean project.
