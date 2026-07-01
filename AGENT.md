# Symphony Agent Operating Notes

This file captures repo-specific commands and real-run testing rules for future agents.

## Standard Commands

Run the full local suite:

```bash
PYTHONPATH=src python3 -m pytest -q
```

Run focused orchestration checks:

```bash
PYTHONPATH=src python3 -m pytest tests/test_orchestrator.py tests/test_linear.py tests/test_acceptance.py -q
```

Run Conductor locally:

```bash
make dev
```

Stop local Conductor/Symphony processes launched by the Makefile:

```bash
make stop
```

Run one Symphony tick from `WORKFLOW.md`:

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
PYTHONPATH=src python3 tools/linear_project_issues.py audit \
  --project HELL \
  --out .test-real-flow/evidence/hell-audit.json
```

Archive active unarchived HELL issues:

```bash
PYTHONPATH=src python3 tools/linear_project_issues.py archive \
  --project HELL \
  --out .test-real-flow/evidence/hell-archive.json
```

Archive only a run-label family:

```bash
PYTHONPATH=src python3 tools/linear_project_issues.py archive \
  --project HELL \
  --label-prefix symphony-real-codex- \
  --out .test-real-flow/evidence/hell-archive-real-codex.json
```

Audit a business issue gate/evidence tree:

```bash
PYTHONPATH=src:tools python3 tools/linear_tree_audit.py HELL-123 \
  --out .test-real-flow/evidence/linear-tree-audit.json
```

Audit persisted retry/continuation state:

```bash
PYTHONPATH=src:tools python3 tools/runtime_claims_audit.py \
  --state /path/to/instances/inst-1/state/symphony.json \
  --log /path/to/instances/inst-1/logs/symphony.log \
  --out .test-real-flow/evidence/runtime-claims-audit.json
```

Observe a running real scenario without mutating Linear:

```bash
PYTHONPATH=src:tools python3 tools/real_run_observer.py \
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
PYTHONPATH=src:tools python3 tools/real_run_evidence_bundle.py \
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
4. Let Symphony create gates, dispatch Codex, verify completion, create evidence, and transition states.
5. Use real `codex app-server` when the scenario says real Codex.
6. Record Linear tree, runtime state, ops snapshot, logs, and cleanup evidence.
7. Archive/audit the test project before and after the scenario.

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
- gate issues are direct children with `symphony:type/gate`;
- evidence issues are children of their gate with `symphony:type/evidence`;
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

- `symphony:continuing` label;
- persisted `continuations`;
- snapshot `continuing`;
- no `retry_attempts` row with `error: null`;
- not counted as a retry/failure.

## When To Stop Waiting

Stop and diagnose instead of continuing to wait when:

- logs repeatedly show `running=0 claimed=1`;
- `already_running_or_claimed` repeats while no worker is running;
- Linear has `symphony:phase/review` but state is not `In Review`;
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
