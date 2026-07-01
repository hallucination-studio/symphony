# Linear Real Acceptance Design

## Goal

Run a real end-to-end acceptance cycle for this repository using the existing Performer + Linear + Codex flow, intentionally using one small real issue to expose product bugs, observability gaps, and unreasonable workflow behavior, then fix the discovered problems in-repo and verify the repaired flow.

## Why This Scope

The repository already contains substantial Linear integration, lifecycle label syncing, milestone comments, Conductor runtime management, and Ops Console telemetry surfaces. The remaining risk is not “isolated unit behavior,” but whether the full operational loop works under real conditions:

- a real Linear issue is selected correctly
- Performer actually dispatches it
- Codex can work inside the repository workspace
- Linear receives usable progress/write-back signals
- Conductor/Ops Console surfaces enough evidence to debug the run
- failures or awkward behaviors can be diagnosed and repaired quickly

The acceptance target is therefore a real but tightly scoped issue that requires an actual repository change and can be verified by focused tests.

## Selected Execution Strategy

Use a **real closure issue** in this repository rather than a write-back-only or failure-only exercise.

Recommended path:

1. choose or create a minimal issue in the configured Linear project with the required `codex2` label
2. ensure the issue asks for a real repository change that should complete in one short run
3. run Performer/Conductor against that issue
4. observe dispatch, tool execution, Linear write-back, and Ops Console drill-down
5. fix any defects or unreasonable behaviors found during the run
6. re-run until the same flow produces strong end-to-end evidence

This gives the best coverage of the actual product promise while still being small enough to iterate on quickly.

## Constraints

- Work in the current checkout rather than a new worktree, because the user explicitly chose that path.
- Do not revert unrelated existing changes in the dirty worktree.
- Use the real `LINEAR_API_KEY` from `.env`.
- Stay within the existing Python + static web stack; no new build systems.
- Treat the user’s objective as the success boundary: real acceptance, real bug discovery, real fixes, and a commit.

## Acceptance Scenario

### Issue Type

The real issue should satisfy all of the following:

- small enough to complete in roughly 10-30 minutes
- requires a real source change in this repository
- has an objective verification path through focused tests or direct runtime evidence
- can be safely executed in the current workspace without broad refactors

Good candidates include:

- fixing a concrete Linear milestone formatting problem
- improving lifecycle label behavior
- tightening Ops Console rendering or missing telemetry presentation
- repairing a small workflow/runtime bug already hinted at by the current reports

### Runtime Path

The acceptance run will use the existing real workflow:

- `WORKFLOW.md` with `tracker.kind: linear`
- project slug `a91b3f7117c7`
- `required_labels: [codex2]`
- active states `Todo` and `In Progress`
- local workspace root `./workspaces`
- Codex app-server via `codex app-server`

### Mandatory Evidence

The flow is only considered proven if evidence exists for all of the following:

1. **Tracker selection**
   - the chosen Linear issue is visible in the configured project and matches dispatch criteria

2. **Real dispatch**
   - Performer starts a run for the issue in the local repository workspace

3. **Repository change**
   - the issue results in actual local code or content changes tied to the requested behavior

4. **Linear write-back**
   - at least one meaningful write-back is observed or validated:
     - lifecycle label sync
     - milestone comment
     - agent-side tracker mutation via `linear_graphql`

5. **Ops visibility**
   - the run is inspectable through the issue-first drill-down:
     `Issue -> Run -> Attempt -> Turn -> Trace`

6. **Defect handling**
   - any discovered bug, defect, or unreasonable behavior is repaired in this repository with verification evidence

7. **Completion hygiene**
   - the resulting fixes are committed to git

## Likely Defect Categories To Probe

This acceptance is specifically intended to uncover defects in these areas:

- lifecycle label replacement or non-idempotent label behavior
- milestone comment clarity, missing fields, or broken debug links
- missing or misleading telemetry fields in run/turn summaries
- trace viewer gaps that make debugging harder than necessary
- failure/retry state explanations that are too vague
- runtime assumptions that break in the actual repository workspace
- discrepancies between unit-tested behavior and real service behavior

## Execution Plan

### Phase 1: Baseline Inspection

- confirm the active workflow, token, project scope, and local launch commands
- inspect current dirty changes so new acceptance findings can be distinguished from pre-existing edits
- identify the most suitable real acceptance issue in Linear

### Phase 2: First Real Run

- launch the relevant local service path (`make once` or managed Conductor runtime, depending on the issue setup)
- capture dispatch behavior, logs, tracker write-back, and ops artifacts
- inspect API or web surfaces for the resulting run data

### Phase 3: Diagnose and Repair

- turn each real failure or unreasonable behavior into a concrete local defect
- implement the smallest defensible fix that serves the real acceptance goal
- add or update focused tests where the defect is code-level and repeatable

### Phase 4: Re-run and Verify

- run the same real issue flow again after fixes
- confirm that the repaired behavior now produces strong evidence across tracker, runtime, and ops surfaces
- run the relevant automated verification commands before any completion or commit claim

## Testing And Verification Expectations

Verification must match the observed defect surface:

- use focused `pytest` targets for code-level fixes
- use direct runtime commands for service behavior
- use API responses or local artifacts for Ops Console/backend evidence
- use current Linear state/comment/label evidence for tracker write-back claims

No success claim is valid unless the proving command or observable state has been checked fresh after the fix.

## Risk Controls

- Prefer a single small issue rather than multiple issues in one pass.
- Avoid speculative refactors not required by a discovered acceptance problem.
- If a failure is caused by an external limitation such as Codex payload omissions, document it precisely and only change local code where the repository can truly improve the outcome.
- Keep the acceptance record grounded in reproducible evidence, not earlier reports.

## Deliverables

The acceptance effort should produce:

- this design spec
- a written implementation/execution plan for the acceptance run
- one or more repository fixes driven by real acceptance findings
- verification evidence from reruns/tests
- a git commit containing the repairs

## Design Review Checklist

- No placeholder sections remain.
- Scope is limited to one real issue flow, not a multi-issue campaign.
- The plan stays aligned with the user’s required end state: real acceptance, bug discovery, repair, and commit.
- Evidence requirements are explicit enough to prevent weak “looks fine” completion claims.
