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

The default Linear application uses `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET`, `LINEAR_REDIRECT_URI`, and
`LINEAR_WEBHOOK_SECRET`. `PODIUM_BASE_URL` must be a public HTTPS origin for
real webhook acceptance. Do not inject a human Linear token or a deployment-
global app actor access token into the managed path. Podium must obtain and
store each workspace installation token through the real OAuth callback.

Use the canonical `PYTHONPATH` when invoking focused tools:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools
```

Managed Codex runs use a staged seed copy. The runner must not default to
`~/.codex`. If local credentials are needed, copy only approved seed files into
a fixed seed directory, set `SYMPHONY_E2E_CODEX_HOME_SEED`, and let the runner
create a per-run copy. The per-run copy must be in a private temporary directory
outside the evidence root, must never be registered as an artifact, and must be
removed after evidence archival and process shutdown. Per-role runtime-home
`auth.json` copies under the E2E data root must also be removed during teardown,
including when a process cleanup step fails.

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
- Linear installation evidence: application source/config version, callback
  acceptance, organization id, app user id, scopes, token health, and cutover
  state, without raw secrets;
- selected project and single-project Conductor binding evidence, including the
  repository mapping and `symphony:conductor/<Name>-<public-id>` label;
- signed webhook delivery, delivery-id dedupe, reconciliation cursor, degraded
  polling health, and proof that webhook plus polling queued one dispatch;
- failed checks with `error_code`, `sanitized_reason`, `action_required`,
  retryability, and next action.

No report with failures but without linked runtime logs is complete evidence.
Linear 401 or 403 must fail on the first request as a non-retryable
`credential_or_config_failure`, preserve its `error_code` and `next_action` in
the report, and direct the operator to reauthorize or repair the active Linear
installation. A failed candidate must not replace a working active
installation.

## Podium Web To Linear Acceptance

1. Start Podium with a clean test database and logs redirected to the evidence
   directory and a public HTTPS callback/webhook origin.
2. In a real browser, choose the default or test customer-owned application and
   complete OAuth as a Linear workspace admin.
3. Verify callback acceptance records the real organization, workspace-specific
   app user, actor, required scopes, project discovery, and sanitized health.
4. Select the test project and verify Podium reads and writes it without
   changing `ProjectUpdateInput.memberIds`.
5. Generate a named Conductor enrollment command, run it, and verify the
   isolated service is online but initially unbound.
6. Bind that Conductor to exactly one selected project and one staged test
   repository; verify a duplicate project or second project binding is rejected.
7. Verify Conductor config acknowledgement and the exact
   `symphony:conductor/<Name>-<public-id>` project label.
8. Delegate a real Linear issue to the installed workspace app user.
9. Verify a signed AgentSession webhook queues one dispatch for the bound
   Conductor. Then suppress one webhook and prove reconciliation polling queues
   the missed issue once without duplicating dispatch.
10. Confirm Conductor leases the dispatch and commits or resumes one managed run.
11. Observe `plan -> work_item -> verify` attempts, request/result files, and
   correlated logs.
12. Confirm downstream work items dispatch only after blockers verify-pass at score
    `>= 3`.
13. Confirm Podium and Linear projection show attempts, waits, failures,
    manifests, and final aggregate state.
14. For application replacement, authorize a second test app, prove the old
    installation remains active until drain/config acknowledgement, then verify
    atomic cutover or a visible blocker.
15. Archive all evidence and remove test issues, managed project labels,
    temporary Conductors, repositories, and installation artifacts.

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

- Podium accepted a webhook or reconciliation result but did not queue a
  dispatch;
- webhook and reconciliation intake queued duplicate dispatches;
- callback acceptance marked an installation ready despite invalid actor,
  missing scope, unknown organization, or inaccessible selected project;
- a failed candidate replaced the active Linear installation;
- a Conductor reported zero or multiple project bindings;
- two active Conductors claimed the same Linear project;
- project binding rewrote project members or used the managed label as routing
  truth;
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
