# Real Run Testing Guide

## Core Rule

Behavior that depends on Linear, Podium, Conductor, Performer, Codex, runtime
profiles, or real scheduler state requires real evidence before it is accepted.
Mocks and unit tests are useful, but they do not prove a managed run works.

Real-run tools must fail loudly on known defects. If an attempt fails, a runtime
wait is created, a proxy call is denied, a Managed Run work item stalls, or an
expected artifact is missing, the tool emits a failing check with a sanitized
reason and archives evidence before continuing or exiting.

## Environment

Real Linear E2E is skipped by default. Load `.env` before running tools that
talk to Linear:

```bash
set -a && source .env && set +a
```

Use the canonical `PYTHONPATH` when invoking focused tools:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools
```

Managed Codex runs use a staged seed copy. The runner must not default to
`~/.codex`. If local credentials are needed, copy only approved seed files into
a fixed seed directory, set `SYMPHONY_E2E_CODEX_HOME_SEED`, and let the runner
create a per-run copy.

## Reusable Tools

Audit or archive active Linear test-project issues:

```bash
.venv/bin/python tools/linear_project_issues.py audit --project HELL --out .test-real-flow/evidence/hell-audit.json
.venv/bin/python tools/linear_project_issues.py archive --project HELL --out .test-real-flow/evidence/hell-archive.json
```

Audit a delegated issue tree and persisted runtime state:

```bash
.venv/bin/python tools/linear_tree_audit.py HELL-123 --out .test-real-flow/evidence/linear-tree-audit.json
.venv/bin/python tools/runtime_claims_audit.py --state /path/to/state/performer.json --log /path/to/logs/performer.log --out .test-real-flow/evidence/runtime-claims-audit.json
```

Observe a run without mutating Linear:

```bash
.venv/bin/python tools/real_run_observer.py --issue HELL-123 --instance-root /path/to/instance --interval 10 --timeout 300 --stop-on-diagnosis --jsonl .test-real-flow/evidence/runtime-samples.jsonl
```

## Required Evidence

A complete managed report includes:

- Podium log and Conductor log;
- per-instance Performer stdout/stderr logs with attempt correlation;
- Managed Run view/report JSON;
- graph, node, attempt, lease, policy, and runtime profile snapshots;
- attempt request/result JSON;
- frozen gate snapshots and verification input snapshots;
- task output manifests and integration/conflict state;
- Linear projection evidence, including issue topology, `blocks`, comments,
  `need_human` states, supersede links, and runtime wait child issues when used;
- failed checks with `error_code`, `sanitized_reason`, `action_required`,
  retryability, and next action.

No report with failures but without linked runtime logs is complete evidence.

## Managed Acceptance Flow

1. Start Podium with a clean test database and logs redirected to the evidence
   directory.
2. Connect or validate Linear OAuth/app state in Podium.
3. Create a runtime group, routing rule, scheduler policy, and per-mode runtime
   profiles.
4. Install or start Conductor with a staged runtime config and fixed data root.
5. Confirm Conductor is enrolled, online, and using the expected policy version.
6. Delegate a Linear issue to the Symphony custom agent.
7. Confirm Podium queues one dispatch for the intended runtime group.
8. Confirm Conductor leases the dispatch and commits or resumes one graph.
9. Observe `plan -> execute -> verify` attempts, request/result files, and
   correlated logs.
10. Confirm downstream nodes dispatch only after blockers verify-pass at score
    `>= 3`.
11. Confirm Podium and Linear projection show attempts, waits, failures,
    manifests, and final aggregate state.
12. Archive all evidence and clean up test issues or labels.

## Human And Runtime Waits

Managed Run `need_human` waits are visible on the affected Linear work item and
resume only when the operator flips that work item out of the blocked-style
state. Comments provide context but do not resume work by themselves.

Runtime approval, permission, and tool-input waits are projected as runtime wait
state and, where product code uses them, `[Human Action]` child issues. Completing
the child issue is the resume signal for that runtime wait. Parent comments and
diagnostic comments must not look like business instructions.

## Failure Signatures

Stop and diagnose immediately when evidence shows:

- Podium accepted a webhook or delegate poll but did not queue a dispatch;
- Conductor leased a dispatch but did not create graph state;
- a non-terminal node has no live driver;
- no heartbeat, backend progress event, result collection event, or durable
  state transition appears for more than one minute during a running attempt;
- an attempt result is rejected by fencing, stale lease, stale gate hash, or
  superseded node id;
- a failed attempt lacks a sanitized reason in logs, durable state, API view, or
  Linear projection;
- a verifier used executor self-report instead of the frozen gate procedure;
- runtime config, Codex home staging, or Linear proxy setup failed silently.

## Local Verification Minimum

Before a real run, execute focused local tests for the area changed and the
canonical full suite when feasible:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_product_docs_pipeline.py -q
make test
```

Local tests are not a substitute for real acceptance when the changed behavior
depends on Linear, runtime orchestration, Codex, or Podium-managed dispatch.
