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

## When To Stop A Real Run

Stop and diagnose instead of waiting when one of these is true:

- the same `already_running_or_claimed` line repeats while no worker is running;
- Linear tree state is unchanged across several polling intervals after worker completion;
- gate/evidence structure is malformed;
- the business issue has contradictory state/phase labels;
- logs show verification/gate failure and no later dispatch is possible;
- the run exceeds the scenario timeout.

Stopping a stuck run is not failure of the test process. It is a valid real acceptance finding. Fix the product bug, archive the test project, and rerun from a clean project.
