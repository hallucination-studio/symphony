# Symphony Agent Operating Notes

This file captures repo-specific commands, product boundaries, coding standards, and real-run testing rules for future agents.

## Product Positioning

Symphony is one product, not four unrelated projects. The repository remains `symphony` because the system is the full orchestra:

- `podium` is the SaaS-facing web boundary. It owns authentication, Linear
  installations, selected projects, Conductor enrollment/binding, dispatch,
  runtime configuration, the Linear proxy, and operator views.
- `conductor` is the customer-side daemon. One Conductor binds exactly one
  Linear project and one repository, owns that project's durable managed-run
  state, starts Performer turns, and reports state/events upward to Podium.
- `performer` is the execution worker. Each short-lived Performer runs exactly
  one fenced managed-run turn from request/result JSON paths.
- `performer_api` is limited to shared Managed Run wire contracts: plans,
  work items/results, turn contexts, runtime policy/profiles, and validation.

Package boundaries are runtime boundaries, not product boundaries. Keep user-facing language anchored in Symphony as the whole system, with Podium, Conductor, and Performer as roles inside that system.

Current hard renames:

- no Python package or CLI named `symphony`;
- the worker CLI is `performer`;
- runtime labels use `performer:*`;
- durable workflow state is `workflow.db`; Performer output is retained in
  per-attempt `performer.log` files;
- Conductor data defaults to `.conductor`;
- Conductor and Performer do not ship a local web console in this build. Conductor exposes the local daemon/API; Podium is the SaaS web boundary.

## Code Standards

- Preserve import boundaries:
  - `performer_api` must not import `performer`, `conductor`, or `podium`;
  - `performer`, `conductor`, and `podium` may import `performer_api`;
  - `performer`, `conductor`, and `podium` must not directly import each other.
- Keep Conductor as the only local process manager for Performer. Conductor should start Performer through the installed `performer` command or the existing repo-local fallback, not by importing Performer internals.
- Keep shared schemas and parsing in `performer_api` when more than one role needs the contract. Keep runtime adapters, subprocess management, tracker clients, and daemon logic in their owning role package.
- Do not reintroduce Performer HTTP status/web UI or Conductor static web UI unless the product direction explicitly changes. Runtime status should flow through durable Managed Run state, Conductor APIs, reports, and correlated logs.
- Avoid compatibility shims for old `symphony` imports, commands, labels, files, or logs unless explicitly requested. This refactor is a hard break.
- Do not print secrets. Settings such as `linear_api_key`, `podium_token`, and environment-resolved tokens may be validated or passed through, but final responses, logs, and API responses must not echo secret values.
- Keep runtime behavior aligned with `docs/product/runtime-pipeline.md`,
  `docs/product/pipeline-state.md`,
  `docs/product/gates-verification-integration.md`,
  `docs/product/linear-projection.md`, and
  `docs/product/runtime-profiles-backends.md`. Do not add legacy scheduling or
  retired workflow-file execution paths.
- Prefer small focused modules over large cross-role files. When adding behavior, put lifecycle, repo materialization, Managed Run reads, registration/reporting, tracker integration, and Codex process handling in clearly owned modules.
- Use structured models and parsers already in the codebase instead of ad hoc string manipulation for workflow config, durable state, API/report snapshots, registration payloads, and Linear data.
- Tests should cover both the role-local behavior and the cross-role contract. Add or update import-boundary tests when package relationships change.

## Scope Authority And No-Inference Rule

Do not expand product behavior from an agent's guess about what would be useful,
complete, conventional, or future-proof. Product scope may come only from an
explicit user request, an accepted product/architecture document, an existing
observable behavior being deliberately preserved, or a named defect/invariant
that the requested work explicitly covers.

- Default to the smallest behavior-preserving implementation that satisfies the
  authorized outcome. Do not add a new actor, customer workflow, state or
  transition, API/DTO field, database fact, configuration option, feature flag,
  retry/fallback policy, integration, UI surface, compatibility path, log
  contract, or acceptance scenario merely because it seems helpful.
- A necessary internal consequence may proceed without separate approval only
  when it is directly required by the authorized outcome, reversible, and does
  not create new customer-visible behavior or a new public/durable/external
  contract. Record the consequence in the slice's scope ledger.
- If an assumption would change customer-visible behavior, public interfaces,
  durable state semantics, external permissions or cost, security posture,
  workflow branching, supported compatibility, or product vocabulary, stop and
  obtain explicit user approval before implementation.
- Discoveries outside scope are reported as deferred candidates, not implemented
  opportunistically. Tests must prove authorized behavior or an existing named
  invariant; a new test must not turn an imagined feature into a requirement.
- Every non-trivial slice starts with a scope ledger containing `authorized`,
  `required_consequences`, `out_of_scope`, `assumptions_requiring_approval`, and
  `deferred_ideas`. `assumptions_requiring_approval` must be empty before
  production changes begin.
- Review must trace every new production behavior and persistent/public contract
  to one authorized source. Untraceable behavior is `UNAPPROVED_SCOPE_EXPANSION`
  and blocks completion.

## Podium UI / Design System

Podium is the only user-facing surface, and its visual identity is captured in a
DESIGN.md file. Before making **any** UI change to the Podium web app, read
`packages/podium/web/DESIGN.md` and follow it. This is mandatory for every
frontend edit, however small.

- The DESIGN.md YAML tokens are normative and mirror the CSS custom properties in
  `packages/podium/web/src/styles/tokens.css`. Consume design values through
  those `--color-*`, `--space-*`, `--radius-*`, and `--font-*` variables — never
  hardcode hex codes, pixel font sizes, or radii in components.
- If you need a value that is not yet a token, add it to DESIGN.md (and
  `tokens.css`) first, then use it. Keep the two in sync.
- After any change to DESIGN.md, lint it and keep it clean (0 errors, 0
  warnings):

  ```bash
  cd packages/podium/web && npm run design:lint
  ```

- Keep Podium onboarding-first and restrained: one indigo accent, near-white
  surfaces, hairline borders over heavy shadows, system fonts only. Never render
  Linear tokens, session cookies, passwords, or client secrets in the UI.


## Standard Commands

Run the full local suite:

```bash
make test
```

Run focused managed-run checks:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_minimal_performer_api.py tests/test_conductor_workflow.py tests/test_podium_runtime_polling.py -q
```

Install all editable packages:

```bash
make install
```

Run Conductor locally:

```bash
make dev
```

Run Podium locally:

```bash
export PODIUM_DATABASE_URL=postgresql://podium@localhost/podium
.venv/bin/podium api --host 127.0.0.1 --port 8090
```

Run a single Performer managed-run turn only through request/result files:

```bash
.venv/bin/performer --turn-request-path /tmp/turn-request.json --turn-result-path /tmp/turn-result.json
```

Stop local Performer/Conductor processes launched by the Makefile:

```bash
make stop
```

## Mandatory Completion Verification

Every requirement must be verified after implementation and before the final response. Claims of completion require fresh evidence from this run.

Verification must prove the user's intended outcome, not just that a command exited successfully. For example, orchestration work must verify actual issue state, tree shape, labels, logs, and persisted runtime state when those are part of the requested behavior.

The final response must be evidence-backed and specific:

- include the exact verification commands or real-run tools used;
- include concrete results such as pass counts, observed Linear identifiers, state transitions, parent-child relationships, evidence artifact paths, or relevant log findings;
- list residual risks or explicitly say what could not be verified and why;
- never treat "cannot verify" as a pass.

For pipeline, Linear, Conductor, Codex, retry, rework, or delegated-work
behavior, local tests are necessary but not sufficient when the behavior spans
the running product. Use the single `tools/real_flow.py` runner and
`docs/real-flow.md`; it performs strict preflight and records a sanitized
report without pretending that a gate passed.

Human intervention must be visible in Linear. Pipeline waits use node-level
`need_human`: Conductor moves the affected issue to the blocked-style state,
records the reason code, and resumes only when the operator flips that issue out
of the blocked-style state. Runtime approval/tool-input waits record a durable
`runtime_wait` with `wait_kind`, `attempt_id`, `lease_id`, sanitized message, and
the projected child issue id when that runtime wait flow uses a `[Human Action]`
child issue. Updating only local stdout, local logs, or a hidden runtime table is
not enough. Comments are informational context and must not resume Performer by
themselves.

This follows the Superpowers verification rule: evidence before claims, always.

## Acceptance Scoring Rubric

Use this score for each completed requirement, especially in final acceptance notes and evidence bundles:

- `0/4`: no executed verification, fake/manual simulation when a real run was required, or no evidence.
- `1/4`: something ran, but it only proves the operation executed, not that the requested outcome works.
- `2/4`: partial verification; unit tests or mocks cover some behavior, but integration outcomes or important edge cases remain unverified.
- `3/4`: meaningful evidence with concrete outputs, but real end-to-end validation is missing where relevant, or non-critical residual risks remain.
- `4/4`: full evidence-backed acceptance: focused tests, outcome checks, real run when required, tree/state/log/evidence audit when relevant, cleanup confirmation, and no unresolved critical gaps.

Hard gates:

- Score cannot exceed `1/4` without actual executed evidence.
- Score cannot exceed `2/4` if mocks are the only verification for behavior that depends on Linear, Conductor, Codex, or runtime orchestration.
- Score cannot exceed `3/4` if the scenario required a real run and no real run was completed.
- Score `4/4` requires concrete evidence: exact commands, observed outputs or artifact paths, checked state, and residual-risk notes.

When reviewing a completed change, score each major requirement independently before giving an overall score. Cite evidence for each score. If a reviewer cannot verify a claim from the available diff, logs, artifacts, or issue state, mark that item as unverified instead of passing it.

Use this final-response shape for non-trivial work:

```text
Verification:
- <command or real-run tool>: <specific result>

Acceptance score:
- <requirement>: <score>/4, because <evidence-backed reason>

Residual risk:
- <remaining gap, or "None identified from the verification above">
```

## Linear real-flow tool

Load `.env` before using the real flow, then run the one supported entrypoint:

```bash
set -a && source .env && set +a
PYTHONPATH=tools .venv/bin/python tools/real_flow.py \
  --project-slug <linear-project-slug> --out .test-real-flow/report.json
```

`tools/linear_fixture.py` is the only helper. It owns project lookup, issue
reads, child-tree reads, and sanitized GraphQL errors; it does not archive
arbitrary projects or provide a second acceptance/audit framework.

## Real Full-Flow Testing Rules

For pipeline, Linear, Conductor, Codex, retry, or rework
changes, mock-only tests are not enough.

A real run must:

1. Use `.env` with the default Linear application's client credentials and
   Podium's fixed callback configuration; never inject a human or deployment-
   global access token into the managed path.
2. Complete the real OAuth callback and record the accepted organization,
   workspace-specific app user, scopes, token health, and selected project.
3. Start and bind one isolated Conductor to that project and the real fixture
   repository before creating the business issue.
4. Create a real Linear business issue after the project binding is ready.
5. Let fully paginated baseline/incremental polling dispatch the issue exactly
   once for its delegation epoch, then let Conductor operate Performer through
   gates, Codex, verification, evidence, and state transitions.
6. Use real `codex app-server` when the scenario says real Codex.
7. Record installation, project binding, polling checkpoints/delegation epoch,
   Linear tree, durable Managed Run database/API/report state, generation and
   attempt logs, cleanup, and deduplication evidence.
8. Write the sanitized report and retain the product-owned logs and state
   artifacts; cleanup is explicit and never inferred from a timeout.

For Podium-managed flows, the real run must additionally follow `docs/real-flow.md`
and the module baselines:

1. Start Podium with the default Linear application's client credentials,
   Podium's fixed OAuth callback URL, and a public HTTPS origin.
   Do not inject a human token or deployment-global app actor access token into
   the managed path.
2. In a real browser, authorize the default or staged customer application with
   `actor=app`; verify callback acceptance for actor, scopes, organization,
   workspace-specific app user, token metadata, and fully paginated project
   access. Verify success and denied consent return to `/setup/linear`.
3. Select the real test project without mutating project `memberIds`.
4. Create a named Conductor enrollment token, run the generated install command,
   and verify the isolated runtime enrolls online but unbound.
5. Bind that Conductor to exactly one selected project and one real fixture
   repository; verify a second project binding and duplicate active Conductor
   for the project are rejected.
6. Verify the exact `symphony:conductor/<Name>-<public-id>` project label, while
   confirming routing uses the durable project binding rather than that label.
7. Delegate a real Linear issue to the installed workspace app user. Verify a
   full baseline or incremental poll queues one dispatch, then prove restart,
   repeated observations, and redelegation preserve checkpoint and epoch
   semantics without a skipped or duplicate dispatch.
8. Let Conductor and Performer complete the work, then verify Podium
   `/api/v1/managed-runs`, Linear projection, turn logs, repository contents,
   installation/binding health, and smoke tests.

Focused regression files for this path include:

- `tests/test_podium_runtime_polling.py`
- `tests/test_conductor_workflow.py`
- `tests/test_workflow_driver.py`
- `tests/test_runtime_contract.py`

Managed runs may create the initial issue and observe state. They must not manually:

- move the business issue to `In Review` or `Done`;
- mutate managed-run plan versions, verification evidence, manifests, integration
  queue rows, or Linear projection metadata outside Conductor's fenced
  turn/result paths;
- mutate managed run or work-item state outside Conductor's fenced turn/result
  paths;
- claim success from fake Codex when real Codex was requested.

## Workflow Acceptance Requirements

For the Linear-native managed runs:

- Conductor's durable `workflow.db` store is the source of truth.
- One Conductor binds exactly one selected Linear project and one repository;
  one project has at most one active Conductor.
- One delegated Linear parent issue maps to one managed run.
- The accepted plan creates bounded ordered tasks with file scope, acceptance
  criteria, and verification commands.
- Performer turns carry run id, task id when applicable, attempt id, turn kind,
  and fencing token.
- Task review runs every declared command and one read-only Codex Gate before
  marking the Linear Sub Issue Done. One failed Gate may rework once; the next
  failure blocks the task and parent.
- Linear projection includes run id, task id, plan version, current workflow
  state, gate status, operator status, and actionable sanitized failure reasons.
- Workflow human-action resumes only through recorded workflow state; runtime
  approval/permission/tool-input waits resume through their recorded runtime wait
  channel, including `[Human Action]` child issues when that flow uses them.

Always verify parent relationships using explicit Linear fields:

```graphql
parent { id identifier }
```

Do not rely only on nested query shape.

## Retry Versus Rework

Use these meanings:

- `retry`: failed or timed-out fenced turn that can be retried under a fresh lease.
- `rework`: managed-run gate failure that returns the task to an executable state.
- `plan revision`: approved change to file scope, acceptance criteria, or human decisions.

Expected evidence:

- turn records with attempt id, fencing token, plan version, and policy revision;
- task transitions through `todo`, `in_progress`, `in_review`, `done`, or `blocked`;
- verification evidence records command results, Codex Gate findings, and artifacts;
- stale or mismatched fenced results are rejected without mutating current state;
- each plan revision is immutable and prior versions remain readable for provenance.

## When To Stop Waiting

Conductor coordination should surface managed-run stalls as structured state rather
than requiring a human to keep waiting and inspect logs:

- expired or missing worker lease;
- stale result rejected by plan/policy revision or fencing token;
- Linear parent/work-item relationship drift;
- verified manifest without integration completion;
- Codex approval or tool-input wait visible only in stdout and not in durable
  runtime wait state plus Linear managed-run projection;
- integration conflict awaiting a human child issue;
- `scenario_timeout_unresolved`;
- Linear projection drift for managed-run metadata.

When a reconcile finding appears, treat it as product evidence: fix the bug,
archive the project if a real run was involved, and rerun from a clean state.

## Current Real-Run Lessons

Past real runs exposed bugs that mock tests missed:

- gate fail returned the business issue to `In Progress` but left it claimed, blocking re-dispatch;
- verifier/human-wait handoffs must not move Linear state without durable graph evidence;
- issue tree checks must inspect explicit `parent` fields;
- real Codex runs can take long enough that hard turn timeouts should be separate from stall timeouts.

Preserve these checks when changing orchestration behavior.
