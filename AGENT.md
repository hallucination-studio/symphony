# Symphony Agent Operating Notes

This file captures repo-specific commands, product boundaries, coding standards, and real-run testing rules for future agents.

## Product Positioning

Symphony is one product, not four unrelated projects. The repository remains `symphony` because the system is the full orchestra:

- `podium` is the SaaS-facing web boundary. In this refactor it is a small HTTP service for Conductor registration and health checks.
- `conductor` is the local daemon, reporting hub, and operator API. It starts, stops, configures, and observes Performer instances, then reports state/events upward to Podium.
- `performer` is the execution worker. A Conductor may operate multiple Performer instances, and each Performer polls assigned work, prepares workspaces, and runs Codex.
- `performer_api` is the shared contract package: workflow/config parsing, persisted state schemas, ops projections, runtime labels, and registration DTOs.

Package boundaries are runtime boundaries, not product boundaries. Keep user-facing language anchored in Symphony as the whole system, with Podium, Conductor, and Performer as roles inside that system.

Current hard renames:

- no Python package or CLI named `symphony`;
- the worker CLI is `performer`;
- runtime labels use `performer:*`;
- managed state/log defaults are `state/performer.json` and `logs/performer.log`;
- Conductor data defaults to `.conductor`;
- Conductor and Performer do not ship a local web console in this build. Conductor exposes the local daemon/API; Podium is the SaaS web boundary.

## Code Standards

- Preserve import boundaries:
  - `performer_api` must not import `performer`, `conductor`, or `podium`;
  - `performer`, `conductor`, and `podium` may import `performer_api`;
  - `performer`, `conductor`, and `podium` must not directly import each other.
- Keep Conductor as the only local process manager for Performer. Conductor should start Performer through the installed `performer` command or the existing repo-local fallback, not by importing Performer internals.
- Keep shared schemas and parsing in `performer_api` when more than one role needs the contract. Keep runtime adapters, subprocess management, tracker clients, and daemon logic in their owning role package.
- Do not reintroduce Performer HTTP status/web UI or Conductor static web UI unless the product direction explicitly changes. Runtime status should flow through persisted state/ops and Conductor APIs.
- Avoid compatibility shims for old `symphony` imports, commands, labels, files, or logs unless explicitly requested. This refactor is a hard break.
- Do not print secrets. Settings such as `linear_api_key`, `podium_token`, and environment-resolved tokens may be validated or passed through, but final responses, logs, and API responses must not echo secret values.
- Keep workflow behavior repo-owned through `WORKFLOW.md`. Conductor may generate and validate managed workflow files, but it should not hide policy in unrelated code paths.
- Prefer small focused modules over large cross-role files. When adding behavior, put lifecycle, repo materialization, ops/retention reads, registration/reporting, tracker integration, and Codex process handling in clearly owned modules.
- Use structured models and parsers already in the codebase instead of ad hoc string manipulation for workflow config, persisted state, ops snapshots, registration payloads, and Linear data.
- Tests should cover both the role-local behavior and the cross-role contract. Add or update import-boundary tests when package relationships change.

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

Run focused orchestration checks:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_orchestrator.py tests/test_linear.py tests/test_acceptance.py -q
```

Install all editable packages:

```bash
make install
```

Run a Performer directly from `WORKFLOW.md`:

```bash
make dev
```

Run Conductor locally:

```bash
.venv/bin/conductor --port 8081 --data-root ./.conductor
```

Run Podium locally:

```bash
.venv/bin/podium --port 8090
```

Stop local Performer/Conductor processes launched by the Makefile:

```bash
make stop
```

Run one Performer tick from `WORKFLOW.md`:

```bash
make once
```

## Mandatory Completion Verification

Every requirement must be verified after implementation and before the final response. Claims of completion require fresh evidence from this run.

Verification must prove the user's intended outcome, not just that a command exited successfully. For example, orchestration work must verify actual issue state, tree shape, labels, logs, and persisted runtime state when those are part of the requested behavior.

The final response must be evidence-backed and specific:

- include the exact verification commands or real-run tools used;
- include concrete results such as pass counts, observed Linear identifiers, state transitions, parent-child relationships, evidence artifact paths, or relevant log findings;
- list residual risks or explicitly say what could not be verified and why;
- never treat "cannot verify" as a pass.

For orchestration, acceptance, Linear, Conductor, Codex, retry, or continuation behavior, local tests are necessary but not sufficient when the behavior spans the running product. Use the real-run tools in this file and `docs/real-run-testing-guide.md`.

For Podium onboarding, Podium Web, runtime enrollment, installed Conductor behavior, Podium dispatch routing, or Linear delegated work, use the `Podium Web To Linear Acceptance` scenario in `docs/real-run-testing-guide.md`. That file is the canonical test procedure for the browser -> Podium -> install command -> local Conductor -> Linear issue -> Performer -> Podium run-completion path; keep new lessons and required checks there rather than duplicating the full flow in this file.

Human intervention must use Linear child issues. When Performer needs input, runtime approval, failure review, or verifier judgment, it must create a `[Human Action]` child issue with `performer:type/human-action` and the relevant `performer:human/*` labels. A real acceptance run is only valid if the human completes that child issue and moves it to `Done`; parent issue comments or command-like comments are informational only and must not resume Performer.

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

## Linear Test Project Tools

Load `.env` before running tools that talk to Linear:

```bash
set -a && source .env && set +a
```

Audit active unarchived HELL issues:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python tools/linear_project_issues.py audit \
  --project HELL \
  --out .test-real-flow/evidence/hell-audit.json
```

Archive active unarchived HELL issues:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python tools/linear_project_issues.py archive \
  --project HELL \
  --out .test-real-flow/evidence/hell-archive.json
```

Archive only a run-label family:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python tools/linear_project_issues.py archive \
  --project HELL \
  --label-prefix performer-real-codex- \
  --out .test-real-flow/evidence/hell-archive-real-codex.json
```

Audit a business issue gate/evidence tree:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools \
  .venv/bin/python tools/linear_tree_audit.py HELL-123 \
  --out .test-real-flow/evidence/linear-tree-audit.json
```

Audit persisted retry/continuation state:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools \
  .venv/bin/python tools/runtime_claims_audit.py \
  --state /path/to/instances/inst-1/state/performer.json \
  --log /path/to/instances/inst-1/logs/performer.log \
  --out .test-real-flow/evidence/runtime-claims-audit.json
```

Observe a running real scenario without mutating Linear:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools \
  .venv/bin/python tools/real_run_observer.py \
  --issue HELL-123 \
  --instance-root /path/to/instances/inst-1 \
  --interval 10 \
  --timeout 300 \
  --stop-on-diagnosis \
  --jsonl .test-real-flow/evidence/runtime-samples.jsonl \
  --out .test-real-flow/evidence/observer-summary.json
```

Bundle real-run evidence:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src:tools \
  .venv/bin/python tools/real_run_evidence_bundle.py \
  --instance-root /path/to/instances/inst-1 \
  --business-issue .test-real-flow/evidence/business-issue.json \
  --linear-tree .test-real-flow/evidence/linear-tree-audit.json \
  --observer .test-real-flow/evidence/runtime-samples.jsonl \
  --cleanup-before .test-real-flow/evidence/cleanup-before.json \
  --cleanup-after .test-real-flow/evidence/cleanup-after.json \
  --out .test-real-flow/evidence/run-bundle
```

## Real Full-Flow Testing Rules

For orchestration, acceptance, Linear, Conductor, Codex, retry, or continuation changes, mock-only tests are not enough.

A real run must:

1. Use `.env` and the real `LINEAR_API_KEY`.
2. Start a Conductor instance first.
3. Create a real Linear business issue after Conductor is running.
4. Let Conductor operate Performer so Performer creates gates, dispatches Codex, verifies completion, creates evidence, and transitions states.
5. Use real `codex app-server` when the scenario says real Codex.
6. Record Linear tree, runtime state, ops snapshot, logs, and cleanup evidence.
7. Archive/audit the test project before and after the scenario.

For Podium-managed flows, the real run must additionally follow `docs/real-run-testing-guide.md#podium-web-to-linear-acceptance`:

1. Start Podium with `PODIUM_LINEAR_ACCESS_TOKEN="$LINEAR_API_KEY"`.
2. Start Podium Web and verify onboarding/runtime/runs with Chrome MCP or an equivalent real browser.
3. Create the Conductor enrollment token from Podium and run the generated install command locally.
4. Verify the installed Conductor reports managed mode, Podium runtime/proxy tokens, and the Podium WebSocket URL.
5. Create a real git fixture repo and a real Linear issue delegated to `$LINEAR_AGENT_APP_USER_ID`.
6. Send the webhook for the actual registered Podium workspace/user id, then let Conductor and Performer complete the work.
7. Verify Podium `/api/v1/runs/recent`, Linear issue state/comments/labels, Performer logs, fixture repo contents, and smoke tests.

Focused regression files for this path include:

- `tests/test_podium_runtime_onboarding.py`
- `tests/test_conductor_podium_channels.py`
- `tests/test_podium_conductor_channels.py`
- `tests/test_podium.py::test_agent_session_webhook_queues_only_delegated_custom_agent_dispatch_and_runtime_acks`
- `tests/test_completion_verifier.py`
- `tests/test_no_podium_memory_state.py`

The harness may create the initial issue and observe state. It must not manually:

- move the business issue to `In Review` or `Done`;
- create gate or evidence issues;
- add pass/fail gate labels;
- create acceptance blocks relations for the new flow;
- call private orchestrator methods to advance phases;
- claim success from fake Codex when real Codex was requested.

## Gate Tree Acceptance Requirements

For the new business issue gate tree:

- business issue is the root;
- gate issues are direct children with `performer:type/gate`;
- evidence issues are children of their gate with `performer:type/evidence`;
- no default `[Acceptance]` sibling issue is created;
- no new default `blocks` relation is the primary acceptance mechanism;
- business issue only reaches `Done` after all gates pass;
- direct `Done` bypass before gate pass is pulled back;
- missing implementation evidence must not enter review.

Always verify parent relationships using explicit Linear fields:

```graphql
parent { id identifier }
```

Do not rely only on nested query shape.

## Retry Versus Continuation

Use these meanings:

- `retry`: exception, timeout, stall, verification failure, or other failure recovery.
- `continuation`: normal follow-up after max turns or other resource boundary while work remains active.

Expected continuation evidence:

- `performer:continuing` label;
- persisted `continuations`;
- snapshot `continuing`;
- no `retry_attempts` row with `error: null`;
- not counted as a retry/failure.

## When To Stop Waiting

Stop and diagnose instead of continuing to wait when:

- logs repeatedly show `running=0 claimed=1`;
- `already_running_or_claimed` repeats while no worker is running;
- Linear has `performer:phase/review` but state is not `In Review`;
- gate/evidence parent relationships are wrong;
- evidence is missing and the issue is in review;
- normal continuation appears in retry state;
- the run exceeds the scenario timeout.

Stopping a stuck run is valid real acceptance evidence. Fix the product bug, archive the project, and rerun from a clean state.

## Current Real-Run Lessons

Past real runs exposed bugs that mock tests missed:

- gate fail returned the business issue to `In Progress` but left it claimed, blocking re-dispatch;
- completion verifier `NEEDS_HUMAN` with acceptance enabled entered review behavior without moving Linear to `In Review`;
- issue tree checks must inspect explicit `parent` fields;
- real Codex runs can take long enough that hard turn timeouts should be separate from stall timeouts.

Preserve these checks when changing orchestration behavior.
