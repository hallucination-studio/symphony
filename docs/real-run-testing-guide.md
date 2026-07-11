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
`LINEAR_CLIENT_SECRET`, and `LINEAR_REDIRECT_URI`. `PODIUM_BASE_URL` must be a
public HTTPS origin for the real OAuth callback. Do not inject a human Linear
token or a deployment-global app actor access token into the managed path.
Podium must obtain and store each workspace installation token through the real
OAuth callback.

The runner also requires `SYMPHONY_E2E_LINEAR_FIXTURE_TOKEN` for test-side issue
creation, delegation, and independent Linear audits. This is a separate fixture
credential, not a Podium installation token or a managed-runtime fallback. It
must be able to read and write the selected test project and delegate issues to
the installed app user. The runner validates project access before Codex or
OAuth work and never forwards this credential into Podium, Conductor, or
Performer.

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

Audit a delegated issue tree and authoritative Managed Run evidence:

```bash
.venv/bin/python tools/linear_tree_audit.py HELL-123 --out .test-real-flow/evidence/linear-tree-audit.json
.venv/bin/python tools/runtime_claims_audit.py --data-root /path/to/conductor-data --instance-id inst-1 --out .test-real-flow/evidence/runtime-claims-audit.json
```

Observe a run without mutating Linear:

```bash
.venv/bin/python tools/real_run_observer.py --issue HELL-123 --instance-root /path/to/conductor-data/instances/inst-1 --interval 10 --timeout 300 --stop-on-diagnosis --jsonl .test-real-flow/evidence/runtime-samples.jsonl
```

Bundle the final evidence. The audit and bundle exit nonzero when the Managed
Run database, generation logs, attempt logs, or turn request/result artifacts
are absent; a generated manifest with missing files is failure evidence, not a
passing report.

```bash
.venv/bin/python tools/real_run_evidence_bundle.py --instance-root /path/to/conductor-data/instances/inst-1 --out .test-real-flow/evidence/run-bundle
```

## Required Evidence

A complete managed report includes:

- Podium log and Conductor log;
- the authoritative `workflow.db` SQLite snapshot;
- every per-attempt `performer.log`, with stdout/stderr and attempt correlation;
- Managed Run view/report JSON;
- graph, node, attempt, lease, policy, and runtime profile snapshots;
- attempt request/result JSON;
- frozen gate snapshots and verification input snapshots;
- task output manifests and integration/conflict state;
- Linear projection evidence, including issue topology, `blocks`, comments,
  `need_human` states, supersede links, and runtime wait child issues when used;
- Linear installation evidence: application source/config version, callback
  acceptance/denial, redirect, organization id, app user id, scopes, token
  refresh/rotation health, and cutover state, without raw secrets;
- selected project and single-project Conductor binding evidence, including the
  repository mapping and `symphony:conductor/<Name>-<public-id>` label;
- fully paginated project discovery, baseline/incremental page checkpoints,
  high-water mark, degraded polling health, delegation epochs, and proof that
  repeated observations queued one dispatch;
- failed checks with `error_code`, `sanitized_reason`, `action_required`,
  retryability, and next action.

No report with failures but without linked runtime logs is complete evidence.
An authenticated Linear `401` permits exactly one serialized refresh-and-retry.
Refresh rejection must fail closed as `reauthorization_required`, preserve its
`error_code` and `next_action`, and direct the operator to authorize again. A
failed candidate must not replace a working active installation.

## Podium Web To Linear Acceptance

1. Start Podium with a clean test database, logs redirected to the evidence
   directory, and a public HTTPS OAuth callback origin.
2. In a real browser, choose the default or test customer-owned application and
   complete OAuth as a Linear workspace admin.
3. Verify callback acceptance records the real organization, workspace-specific
   app user, actor, exact scopes, fully paginated project discovery, and token
   metadata, then returns `303 See Other` to `/setup/linear`.
4. Deny a fresh authorization and verify denied consent returns to the same
   setup page with a durable sanitized error while the active install is intact.
5. Select the test project and verify Podium reads and writes it without changing
   `ProjectUpdateInput.memberIds`.
6. Generate a named Conductor enrollment command, run it, and verify the
   isolated service is online but initially unbound.
7. Bind that Conductor to exactly one selected project and one staged test
   repository; verify a duplicate project or second project binding is rejected.
8. Verify Conductor config acknowledgement and the exact
   `symphony:conductor/<Name>-<public-id>` project label.
9. Delegate real Linear issues before and after binding readiness, then verify
   full baseline and incremental polling traverses every page without duplicate
   dispatch or skipped issue and advances only committed checkpoints.
10. Repeat polls, restart mid-page, observe an undelegation, and redelegate the
    same issue. Verify one dispatch per delegation epoch, one durable Managed
    Run for the issue, and crash-safe resume.
11. Confirm Conductor leases each dispatch and commits or resumes one managed run.
12. Observe `plan -> work_item -> verify` attempts, request/result files, and
   correlated logs.
13. Confirm downstream work items dispatch only after blockers verify-pass at score
    `>= 3`.
14. Confirm Podium and Linear projection show attempts, waits, failures,
    manifests, and final aggregate state.
15. Exercise same-identity reauthorization and prove credentials rotate without
    draining. Then authorize a second test app, prove the old installation
    remains active until drain/config acknowledgement, and verify atomic cutover
    or a visible blocker.
16. Verify organization mismatch requires explicit reset or migration and never
    replaces the active installation.
17. Force token expiry/refresh, one `401`, refresh rejection, polling backoff, and
    recovery; verify durable and sanitized health at every step.
18. Archive all evidence and remove test issues, managed project labels,
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

- a polling page committed observations but did not queue its eligible dispatch;
- a checkpoint advanced past an uncommitted page or an issue was skipped at an
  equal-timestamp boundary;
- repeated observations queued duplicate dispatches within one delegation epoch;
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
  .venv/bin/python -m pytest tests/test_minimal_performer_api.py tests/test_conductor_workflow.py tests/test_podium_runtime_polling.py -q
make test
```

Local tests are not a substitute for real acceptance when the changed behavior
depends on Linear, runtime orchestration, Codex, or Podium-managed dispatch.
