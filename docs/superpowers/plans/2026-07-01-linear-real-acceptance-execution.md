# Linear Real Acceptance Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute one real Linear-driven repository change through Symphony, diagnose real end-to-end defects, repair them, rerun the flow, and commit the validated fixes.

**Architecture:** The acceptance run uses the existing local Symphony/Conductor stack, the real Linear project configured in `WORKFLOW.md`, and one tightly scoped repository issue. Evidence is collected from tracker state, runtime logs, ops snapshot/API output, and focused test runs. Only defects discovered through the real run are repaired.

**Tech Stack:** Python 3.12+, pytest, asyncio, Linear GraphQL API, Codex app-server, Conductor JSON API, static web assets.

---

### Task 1: Freeze The Acceptance Baseline

**Files:**
- Modify: `docs/superpowers/specs/2026-07-01-linear-real-acceptance-design.md`
- Create: `docs/superpowers/plans/2026-07-01-linear-real-acceptance-execution.md`

- [ ] **Step 1: Re-read the design spec and inspect the dirty worktree**

Run:

```bash
sed -n '1,260p' docs/superpowers/specs/2026-07-01-linear-real-acceptance-design.md
git status --short
```

Expected: the spec states one real Linear closure issue, and the worktree output shows the pre-existing modified files that must not be reverted accidentally.

- [ ] **Step 2: Verify the real workflow configuration and token source**

Run:

```bash
sed -n '1,220p' WORKFLOW.md
sed -n '1,40p' .env
```

Expected: `tracker.kind: linear`, project slug `a91b3f7117c7`, required label `codex2`, and a non-empty `LINEAR_API_KEY`.

- [ ] **Step 3: Force-add the spec and plan docs to git staging**

Run:

```bash
git add -f docs/superpowers/specs/2026-07-01-linear-real-acceptance-design.md \
  docs/superpowers/plans/2026-07-01-linear-real-acceptance-execution.md
```

Expected: no error even though `docs/superpowers` is ignored.

- [ ] **Step 4: Commit the acceptance docs**

Run:

```bash
git commit -m "docs: add linear real acceptance plan"
```

Expected: one commit containing the spec and plan documents only.

### Task 2: Select Or Create The Real Linear Issue

**Files:**
- Modify: `.test-real-flow/acceptance-issue.json`

- [ ] **Step 1: Query candidate issues in the configured Linear project**

Run:

```bash
set -a && source .env && set +a
python - <<'PY'
import json
import os
import urllib.request

query = """
query AcceptanceCandidates($projectSlug: String!) {
  issues(
    first: 10
    filter: {
      project: { slugId: { eq: $projectSlug } }
      labels: { some: { name: { eq: "codex2" } } }
      state: { name: { in: ["Todo", "In Progress"] } }
    }
  ) {
    nodes {
      id
      identifier
      title
      state { name }
      labels { nodes { name } }
    }
  }
}
"""
payload = json.dumps({
    "query": query,
    "variables": {"projectSlug": "a91b3f7117c7"},
}).encode()
req = urllib.request.Request(
    "https://api.linear.app/graphql",
    data=payload,
    headers={"Authorization": os.environ["LINEAR_API_KEY"], "Content-Type": "application/json"},
)
with urllib.request.urlopen(req) as resp:
    data = json.load(resp)
print(json.dumps(data, indent=2))
PY
```

Expected: at least one candidate issue appears, or the result is empty and a new issue must be created.

- [ ] **Step 2: Create a minimal real issue if no suitable candidate exists**

Run:

```bash
mkdir -p .test-real-flow
set -a && source .env && set +a
python - <<'PY'
import json
import os
import urllib.request

query = """
mutation CreateAcceptanceIssue($teamId: String!, $projectId: String!, $title: String!, $description: String!, $labelIds: [String!]) {
  issueCreate(input: {
    teamId: $teamId
    projectId: $projectId
    title: $title
    description: $description
    labelIds: $labelIds
  }) {
    success
    issue { id identifier title url }
  }
}
"""
variables = {
    "teamId": "REPLACE_TEAM_ID",
    "projectId": "REPLACE_PROJECT_ID",
    "title": "Acceptance: tighten one real Symphony behavior",
    "description": "Use this issue for end-to-end acceptance. Make one small real improvement in this repository, verify it, and report the result.",
    "labelIds": ["REPLACE_CODEX2_LABEL_ID"],
}
payload = json.dumps({"query": query, "variables": variables}).encode()
req = urllib.request.Request(
    "https://api.linear.app/graphql",
    data=payload,
    headers={"Authorization": os.environ["LINEAR_API_KEY"], "Content-Type": "application/json"},
)
with urllib.request.urlopen(req) as resp:
    data = json.load(resp)
print(json.dumps(data, indent=2))
PY
```

Expected: this step is only used after first resolving real `teamId`, `projectId`, and `codex2` label id from the live project; the created issue becomes the single acceptance target.

- [ ] **Step 3: Record the chosen issue locally for repeatable reruns**

Create `.test-real-flow/acceptance-issue.json` with:

```json
{
  "issue_id": "lin-issue-id",
  "issue_identifier": "ABC-123",
  "title": "Acceptance target title",
  "url": "https://linear.app/.../issue/ABC-123/..."
}
```

- [ ] **Step 4: Verify the issue matches dispatch rules**

Run:

```bash
python - <<'PY'
import json
from pathlib import Path

issue = json.loads(Path(".test-real-flow/acceptance-issue.json").read_text())
assert issue["issue_id"]
assert issue["issue_identifier"]
assert issue["title"]
assert issue["url"]
print(issue["issue_identifier"], issue["title"])
PY
```

Expected: the chosen issue metadata is present and stable for later reruns.

### Task 3: Run The First Real Acceptance Pass

**Files:**
- Modify: `.test-real-flow/first-run.log`
- Modify: `.test-real-flow/first-run-state.json`

- [ ] **Step 1: Ensure the local environment is installed**

Run:

```bash
make install
```

Expected: `.venv` exists and the editable package plus test dependencies are installed.

- [ ] **Step 2: Run one real Symphony polling cycle**

Run:

```bash
set -a && source .env && set +a
PYTHONPATH=$(pwd)/src .venv/bin/symphony WORKFLOW.md --once | tee .test-real-flow/first-run.log
```

Expected: the log shows candidate polling, issue selection or skip reasoning, and if dispatched, a real worker run for the chosen issue.

- [ ] **Step 3: Capture the latest persisted state and ops artifacts**

Run:

```bash
find . -path '*ops.json' -o -path '*symphony.json'
```

Expected: at least one relevant runtime state file exists, or the absence itself becomes evidence of a defect in the acceptance chain.

- [ ] **Step 4: Snapshot the first-run outcome**

Run:

```bash
python - <<'PY'
import json
from pathlib import Path

log = Path(".test-real-flow/first-run.log").read_text(encoding="utf-8")
summary = {
    "dispatched": "dispatch" in log.lower() or "running" in log.lower(),
    "saw_linear_writeback": "symphony_lifecycle_label" in log or "milestone" in log.lower(),
    "log_size": len(log),
}
Path(".test-real-flow/first-run-state.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps(summary, indent=2))
PY
```

Expected: a minimal machine-readable first-run summary exists for comparison after repairs.

### Task 4: Turn Real Findings Into Fixes

**Files:**
- Modify: exact source and test files indicated by the first run

- [ ] **Step 1: Extract the concrete defect from the first-run evidence**

Run:

```bash
sed -n '1,240p' .test-real-flow/first-run.log
cat .test-real-flow/first-run-state.json
```

Expected: one specific failure, missing behavior, or unreasonable UX/debugging gap is identified before touching code.

- [ ] **Step 2: Write or update the failing focused test for that defect**

Run a targeted test command appropriate to the discovered defect, for example:

```bash
PYTHONPATH=$(pwd)/src .venv/bin/python -m pytest tests/test_linear.py -q
```

Expected: at least one targeted test fails for the discovered issue, or if the issue is runtime-only, the absence of a targeted test is documented and the runtime repro remains the proving mechanism.

- [ ] **Step 3: Implement the minimal repair in the relevant source file**

Use `apply_patch` to modify only the files justified by the first-run failure. The exact patch is determined by the defect, but it must stay narrow and preserve unrelated dirty changes.

- [ ] **Step 4: Re-run the focused verification for the repair**

Run the exact proving command for the repaired defect, for example:

```bash
PYTHONPATH=$(pwd)/src .venv/bin/python -m pytest tests/test_linear.py tests/test_orchestrator.py -q
```

Expected: the previously failing focused checks now pass, or the runtime-only repro now demonstrates the repaired behavior.

### Task 5: Re-run The Real Flow And Capture End-To-End Evidence

**Files:**
- Modify: `.test-real-flow/second-run.log`
- Modify: `.test-real-flow/second-run-state.json`

- [ ] **Step 1: Run the same real acceptance flow again after the fix**

Run:

```bash
set -a && source .env && set +a
PYTHONPATH=$(pwd)/src .venv/bin/symphony WORKFLOW.md --once | tee .test-real-flow/second-run.log
```

Expected: the repaired behavior is observable in the second run.

- [ ] **Step 2: Inspect the relevant ops/backend evidence**

Run:

```bash
python - <<'PY'
from pathlib import Path

for path in sorted(Path(".").glob("**/ops.json")):
    print(path)
    print(path.read_text(encoding="utf-8")[:2000])
    break
PY
```

Expected: the issue/run/attempt/turn/trace data is present and usable, or any remaining gap is now sharply defined.

- [ ] **Step 3: Capture the second-run summary**

Run:

```bash
python - <<'PY'
import json
from pathlib import Path

log = Path(".test-real-flow/second-run.log").read_text(encoding="utf-8")
summary = {
    "dispatched": "dispatch" in log.lower() or "running" in log.lower(),
    "saw_linear_writeback": "symphony_lifecycle_label" in log or "milestone" in log.lower(),
    "log_size": len(log),
}
Path(".test-real-flow/second-run-state.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print(json.dumps(summary, indent=2))
PY
```

Expected: the second-run summary reflects equal or better end-to-end evidence than the first run.

### Task 6: Verify, Review, And Commit The Repairs

**Files:**
- Modify: repository files touched by the real fix

- [ ] **Step 1: Run the full relevant verification set**

Run:

```bash
PYTHONPATH=$(pwd)/src .venv/bin/python -m pytest -q
PYTHONPATH=$(pwd)/src .venv/bin/python -m compileall src
```

Expected: the test suite and bytecode compilation both succeed, or any known pre-existing failure is explicitly separated from the acceptance fix with evidence.

- [ ] **Step 2: Review the actual diff before commit**

Run:

```bash
git status --short
git diff -- docs/superpowers/specs/2026-07-01-linear-real-acceptance-design.md \
  docs/superpowers/plans/2026-07-01-linear-real-acceptance-execution.md \
  src tests .test-real-flow
```

Expected: the diff reflects the acceptance docs, runtime evidence artifacts, and the defect-driven repair only.

- [ ] **Step 3: Commit the verified acceptance repairs**

Run:

```bash
git add -f docs/superpowers/specs/2026-07-01-linear-real-acceptance-design.md \
  docs/superpowers/plans/2026-07-01-linear-real-acceptance-execution.md \
  .test-real-flow
git add src tests README.md Makefile WORKFLOW.md
git commit -m "fix: repair real linear acceptance flow"
```

Expected: a commit exists containing the repair and the supporting acceptance artifacts.
