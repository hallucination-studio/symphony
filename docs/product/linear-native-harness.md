# Linear-Native Harness

## Purpose

The runtime is a controlled harness, not a scheduler. One delegated Linear issue
becomes one agent run. The agent plans the work and executes it; the harness
controls the boundaries, verifies every result, and projects state to Linear.
Parallelism lives inside the agent's own subagent mechanism, not in a Conductor
dependency graph.

This replaces the DAG node scheduler, aggregate parent nodes, dual dependency
policies, mode-capacity accounting, and the standalone `plan/execute/verify`
node projection. Those are not product paths.

## Core Principle

The harness is a run controller, not a scheduler:

- no dependency-graph engine, no predicate state machine;
- one Linear parent issue maps to one agent run;
- the agent's plan produces work items; work items map to Linear sub-issues;
- the harness drives the approved plan, collects events, verifies results, and
  writes Linear.

Work-item parallelism is expressed by a backend capability within a single run.
Codex supports subagent workflows; other backends must advertise an equivalent
capability before the harness asks them to parallelize. The harness never fans
out across nodes itself, so cross-node fan-in, merge conflict resolution, and
"blocker verify-passed = satisfied" bookkeeping do not exist in the harness.

## Authority Boundary

Two state streams are tracked separately by trust level, and each writes a
different Linear surface.

**Agent state** is self-reported, high-frequency, low-trust. It narrates what
the agent believes it is doing. It may request progress updates through the
Linear Projector. It may never decide a terminal state or write Linear directly.

**Conductor state** is harness-owned, low-frequency, high-trust, and durable. It
is the authority. Only Conductor state moves a Linear surface across a terminal
boundary (Done, Blocked, Failed).

Conflict rule: on any authoritative Linear-state conflict, Conductor state
overrides agent state. If the agent claims a work item is done and harness
verification fails, the sub-issue goes to Blocked, not Done, and the failure
reason is written to Linear. This is the mechanism that makes stalls
diagnosable.

## Skill-Derived Contracts

The harness fixes engineering skills into machine-checked contracts rather than
installed guidance. The methodology lives in harness schemas, state transitions,
and gates, not in backend-specific prompt text. A plan that does not satisfy the
schema is rejected before execution — this is what "the plan is always built
this way" means in practice.

- **planning-and-task-breakdown** defines the plan schema (§Plan Contract).
- **incremental-implementation** defines the execution protocol (§Execution
  Contract).
- **test-driven-development** defines the RED/GREEN evidence contract.
- The **Definition of Done** defines the final harness acceptance gate.
- **orchestration-patterns** defines when internal agent parallelism is allowed
  and when a work item must stay sequential.

Skills are consumed as contract sources, not copied wholesale into every prompt.
The backend may receive concise skill-specific instructions, but the durable
truth is the validated plan, work-item result, file impact manifest, and harness
acceptance record.

## Plan Contract

The first turn is plan-only and must not change files. For Codex this is a
harness-enforced turn, not a native SDK mode: the harness starts or resumes the
Codex thread with a read-only sandbox for the planning turn, requests the plan
schema as structured output when the SDK supports it, validates the returned
schema, and rejects the turn if the worktree diff changes. This keeps the
contract enforceable without depending on an undocumented `plan` mode.

Backends may expose stronger native planning controls, but the portable contract
is `plan_only_guarantee = harness_enforced`. The turn returns:

```json
{
  "summary": "user-visible interpretation of intent",
  "architecture_decisions": ["key decision and rationale"],
  "work_items": [
    {
      "id": "wi-1",
      "title": "verb-first, single-responsibility title",
      "objective": "what this work item accomplishes",
      "slice_type": "vertical | contract-first | risk-first | test-only | docs-only | research",
      "acceptance_criteria": ["specific, testable condition"],
      "verification": {
        "red_command": "test command that FAILS before the change (TDD RED)",
        "green_commands": ["pytest tests/test_xxx.py -q"],
        "runtime_checks": ["manual or runtime check when tests are insufficient"]
      },
      "dependencies": ["wi-0"],
      "estimated_scope": "XS | S | M",
      "files_likely_touched": ["src/...", "tests/..."],
      "parallelization": {
        "safe_to_parallelize": false,
        "parallel_group": null,
        "reason": "why this can or cannot run in parallel inside the agent",
        "shared_contracts": ["path/to/api-or-schema"],
        "merge_strategy": "single worktree | isolated worktree"
      },
      "needs_human_approval": false
    }
  ],
  "checkpoints": [{ "after": ["wi-1", "wi-2"], "verify": ["all tests pass"] }],
  "verification_rubric": {
    "correctness": ["task-specific acceptance criteria to prove"],
    "quality": ["scope discipline and code-quality checks"],
    "integration": ["checkpoint, build, and integration checks"],
    "documentation": ["Linear and docs updates required for this run"],
    "ship_readiness": ["security, rollback, observability, and residual-risk checks"]
  },
  "risks": [{ "risk": "...", "impact": "high|med|low", "mitigation": "..." }],
  "open_questions": ["information a human must supply"],
  "approval_required": true
}
```

The harness validates the plan at generation time and rejects it back to the
agent when a rule is violated:

| Rule | Source | On violation |
|---|---|---|
| `estimated_scope` is L or XL | task sizing | reject, require further breakdown |
| `acceptance_criteria` has more than 3 entries | "can't describe it tightly = too large" | reject, require further breakdown |
| title contains " and " | "and in title = two tasks" | reject |
| behavioral work item lacks `verification.red_command` | TDD RED | reject |
| `dependencies` contain a cycle | dependency graph | reject |
| a work item spans two or more independent subsystems | breakdown rule | reject |
| `files_likely_touched` is empty for a code-changing item | file impact visibility | reject |
| `parallelization.safe_to_parallelize` is true without independent file scopes or shared contract | orchestration-patterns | reject |
| `verification_rubric` is missing a Definition-of-Done area | final report quality | reject |

`open_questions` is the "advance hard, ask only when truly blocked" path: the
agent surfaces genuinely missing information here, the harness turns it into a
human question on Linear, and execution does not silently stall mid-run.

Plan validation retries are bounded. After the configured number of failed
attempts the harness escalates to a human through `open_questions` rather than
looping.

The approved plan is immutable for execution. If implementation discovers that a
work item needs a new file scope, dependency, acceptance criterion, or human
decision, the agent must return a `plan_revision_requested` result instead of
silently continuing. The harness projects the revision reason to Linear, asks for
approval when configured, and stores the approved revision as a new plan version
while preserving the original for audit.

## Execution Contract

After approval the harness drives work items in dependency order. Each work item
is one incremental slice and one harness-controlled turn boundary. The harness
does not ask the backend to execute "the next few tasks"; it issues a fixed
instruction for exactly one work item:

```
Continue the approved plan. Execute work item wi-1 only.
Rules (incremental-implementation):
- Simplicity first: write the plainest obviously-correct implementation.
- Scope discipline: touch only wi-1's files_likely_touched.
- Keep it compilable: the project builds and existing tests pass at turn end.
- Make verification.red_command go RED, then make green_commands pass (TDD).
Return the structured work-item manifest when finished. If this backend exposes
a result-submission tool, call that tool instead of free-form text.
```

Scope discipline is harness-verifiable, not advisory: after the turn, the
harness compares `git diff --name-only` against `files_likely_touched`. A change
to an undeclared file fails verification unless the turn returned
`plan_revision_requested` before making the out-of-scope change.

Within one work item the agent may fan out to its own subagents for internal
parallelism only when the approved `parallelization` contract permits it.
Parallelism is appropriate for independent feature slices, review, test
analysis, documentation, or read-heavy research. It is not allowed for shared
mutable state, migrations, dependency chains, or two writers touching the same
files without an explicit shared contract. The harness sees one run and one
work-item boundary; subagent events are implementation detail.

Every two or three verified work items, or at each explicit checkpoint from the
plan, the harness runs the checkpoint verification commands before advancing.
Checkpoint failures block the parent issue even if each individual sub-issue
looked locally complete.

## Acceptance Contract

The closing turn must return a structured work-item result. For Codex this is
enforced by the same harness pattern as planning: request structured output when
available, validate the schema, retry bounded invalid outputs, and reject the
turn if the result is missing or malformed. Backends that support tool-choice
style enforcement may expose this as a `submit_work_item_result` tool, but the
shared contract is the validated result object, not a backend-specific tool
mechanism:

```json
{
  "work_item_id": "wi-1",
  "status_claimed": "ready_for_review | blocked | plan_revision_requested",
  "changed_files": [
    {
      "path": "...",
      "action": "created | modified | deleted",
      "planned": true,
      "reason": "why this file changed",
      "handling": "kept | reverted | needs_review",
      "verification": ["pytest tests/test_xxx.py -q"]
    }
  ],
  "undeclared_files": [],
  "tests": {
    "red_command": "pytest tests/test_xxx.py::test_case -q",
    "red_observed": true,
    "green_commands_run": ["pytest tests/test_xxx.py -q"]
  },
  "acceptance_results": [
    { "criterion": "specific, testable condition", "status": "passed" }
  ],
  "blocked_reason": null,
  "plan_revision": null,
  "notes": "human-readable narrative"
}
```

The harness does not trust this report. It runs its own acceptance pass — the
machine form of the Definition of Done:

1. the changed-file set is a subset of `files_likely_touched` (scope);
2. `verification.red_command` genuinely FAILS with the change stashed (TDD RED,
   verified by stash / run / pop, blocking fake always-green tests);
3. the harness itself reruns `verification.green_commands` and all pass (never
   trust the agent ran them);
4. each acceptance criterion is satisfied;
5. changed files have a recorded reason and handling decision;
6. secret scan passes and the worktree integrates cleanly.

All pass → Conductor state becomes `verified`; the sub-issue may go Done. Any
failure → Conductor state becomes `blocked`/`failed`, and the Linear comment
records which check failed, the agent's claim, and the actual result.

The file impact manifest is a first-class artifact. It is how a user answers
"what did the agent change, why, and what should I do with those files?" without
opening local logs. Undeclared file changes, missing reasons, or files marked
`needs_review` keep the work item out of Done until resolved.

After all work items and checkpoints pass, the harness produces a
`thread_completion_report`. This is not a free-form Codex victory lap. It is a
harness-generated report assembled from the approved plan, work-item result
manifests, changed-file set, checkpoint results, Codex event summaries, token
usage, and residual-risk records:

```json
{
  "status": "verified",
  "thread_id": "codex-thread-id",
  "plan_version": 1,
  "what_this_thread_did": [
    "planned two bounded work items",
    "executed wi-1 in one harness-controlled turn",
    "executed wi-2 in one harness-controlled turn",
    "verified the checkpoint after both work items"
  ],
  "files_changed": [
    {
      "path": "src/...",
      "action": "modified",
      "work_item_id": "wi-1",
      "reason": "implements acceptance criterion 1",
      "handling": "kept"
    }
  ],
  "rubric_results": [
    {
      "area": "correctness",
      "status": "passed",
      "evidence": ["wi-1 acceptance criteria passed"]
    }
  ],
  "token_usage": [
    {
      "turn": "plan",
      "input_tokens": 0,
      "cached_input_tokens": 0,
      "output_tokens": 0,
      "reasoning_output_tokens": 0
    }
  ],
  "residual_risks": []
}
```

The `verification_rubric` from the plan defines the standing bar for this
report. It is derived from the Definition of Done: correctness, quality,
integration, documentation, and ship-readiness. The harness may ask Codex to
draft human-readable wording, but the pass/fail values and file lists come from
harness evidence.

## Linear Projection

The Linear Projector is the only writer of Linear. Surfaces map to state
streams by trust level:

| Linear surface | Writer | State source |
|---|---|---|
| parent issue description managed block | Linear Projector | latest stable run summary: plan version, status, completion report, rubric results, file impact, token usage, residual risks |
| parent issue comment | Linear Projector | agent-state narration, turn events, hook summaries, checkpoint failures, recovery notes |
| sub-issue description | Linear Projector | work-item objective, acceptance criteria, likely files, verification commands, dependencies |
| sub-issue workflow state | Linear Projector | agent state may request In Progress; only harness verification sets Done |
| sub-issue comment | Linear Projector | file impact manifest, acceptance result, RED/GREEN, rerun output |
| parent issue workflow state | Linear Projector | Conductor state only: all work items verified → Done; any unrecoverable block → Blocked |

The root business issue is immutable delegated intent and the run's status
anchor.

Linear projection is intentionally compact but complete. The parent issue should
let an operator see the whole run at a glance; each child issue should explain
one bounded work item well enough to review, resume, or debug it. Backend stdout
and native events are not pasted line-by-line into Linear.

The root issue description is updated through a managed block only. The
Projector must preserve the user's original issue description and replace only
the content between stable markers:

```md
<!-- symphony:run-summary:start -->
## Symphony Run Summary

Status: Verified
Thread: codex-thread-id
Plan version: 1

### What This Thread Did
- Planned and executed bounded work items.

### Files Changed
| File | Action | Work Item | Reason |
|---|---|---|---|
| `src/...` | modified | wi-1 | implements acceptance criterion 1 |

### Verification Rubric
| Area | Result | Evidence |
|---|---|---|
| Correctness | Pass | acceptance criteria passed |

### Token Usage
| Turn | Input | Cached Input | Output | Reasoning Output |
|---|---:|---:|---:|---:|
| plan | 0 | 0 | 0 | 0 |

### Residual Risks
- None identified.
<!-- symphony:run-summary:end -->
```

Comments remain the right surface for chronological progress. The root
description is the current state summary.

## Conductor Execution States

The authoritative, durable, low-frequency state set is small:

```
queued -> planning -> awaiting_approval -> executing(wi-k) -> verifying(wi-k)
       -> verified(wi-k) -> ... -> done
                                \-> blocked
                                \-> failed
```

Agent state is free-form and high-frequency (`planning_started`, `file_changed`,
`test_started`, ...) and only feeds comments, so its noise never touches an
authoritative surface. The harness does not infer `wi-1 complete` or `wi-2
started` from native events. Those transitions happen only because the harness
started a bounded work-item turn and later verified its result.

## Backend Abstraction

Only two ports are backend-specific; everything else is shared. The skill
methodology sits in the shared contracts, so the backend is replaceable without
touching it.

```
AgentBackend (port)
  start_run(worktree, agent_home) -> run_id
  plan_turn(prompt) -> plan_json          # read-only + forced/validated plan schema
  execute_turn(work_item)                 # triggers execution; events via adapter
  submit_turn() -> work_item_result       # forced/validated result schema
  resume(run_id)                          # crash recovery
  stop(run_id)
    |- CodexBackend  : Codex SDK thread + resume + read-only planning turn + structured result validation + CODEX_HOME
    \- ClaudeBackend : Agent SDK session + planning controls + tool/result schema + isolated config home

EventAdapter (port), one per backend
  native events -> canonical events -> comments only
    |- CodexEventAdapter  : Codex lifecycle hooks + exec/SDK JSON events -> canonical
    \- ClaudeEventAdapter : PreToolUse/PostToolUse/Stop hooks -> canonical
```

Codex SDK supports programmatic threads, repeated `run()` calls on the same
thread, resuming an existing thread, and per-turn sandbox overrides. The
documented portable way to make a Codex planning turn non-mutating is therefore
read-only sandbox plus post-turn diff verification. Do not model Codex as having
a native SDK `plan` mode unless the backend adapter proves and tests that
capability for the pinned SDK version.

The largest risk is shared and backend-neutral: native agent events are not a
business protocol. Neither backend can be assumed to natively emit reliable
`work_item_started` or `work_item_completed` events. Reliable per-work-item state
therefore comes from harness-controlled turn boundaries and the forced
closing-turn schema, not from a webhook. Process events feed comments and
heartbeats only, so their unreliability never reaches an authoritative surface.

Codex exposes two useful event surfaces for the adapter:

- **Lifecycle hooks** such as `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, and `Stop`. These hooks receive structured stdin with fields
  such as `session_id`, `turn_id`, `tool_name`, `tool_input`, `tool_response`,
  `last_assistant_message`, and `transcript_path`. They are useful for Linear
  comments like "turn started", "tool ran", "command output passed", and
  "assistant stopped".
- **`codex exec --json` / SDK stream events** such as `thread.started`,
  `turn.started`, `item.started`, `item.completed`, `turn.completed`, and
  `turn.failed`. `turn.completed` includes token usage, so the harness can record
  per-turn token totals without parsing free-form output.

Neither surface is the work-item state machine. Hooks and JSON events can update
operator-facing Linear comments and usage summaries, while authoritative
`wi-k started`, `wi-k verified`, `wi-k blocked`, and parent Done transitions
remain harness decisions.

## Component Flow

```
Linear parent issue delegated
        |
   [ Queue ]  enqueue / claim / heartbeat / timeout / cancel  (provider-neutral)
        | claim
   [ Harness (run controller) ]
     1. create worktree + isolated agent_home
     2. AgentBackend.plan_turn -> validate plan schema  --(invalid)--> reject, replan
     3. plan -> Linear sub-issues (Linear Projector)
     4. approval gate (config-driven; default not blocking)
     5. for each work item in dependency order:
          execute_turn(wi-k only) -> submit_turn (forced schema)
     6. harness independent acceptance pass (file impact, TDD, DoD)
     7. checkpoint verification when due
     8. advance Conductor state + Linear Projector update
        |                              |
   [ EventAdapter ]              [ Linear Projector ]  (only Linear writer)
   (low-trust canonical events)  (high-trust authoritative state)
```

## Crash Recovery

Crash recovery is a hard requirement. The minimum durable state is persisted;
the recovery unit is one work item.

```
run:      run_id, backend_session_id (thread/session), worktree_path, agent_home
plan:     approved plan JSON (immutable)
progress: current work item, per-work-item Conductor state, approval state
```

On restart the harness reads progress, finds the first work item that is not
`verified`, calls `AgentBackend.resume(session_id)`, and replays from there.
Already-`verified` work items are not rerun (idempotent). An in-flight parallel
subagent lost to the crash is not individually recoverable; the whole work item
reruns. Recovery granularity is the work item, not the subagent.

## Configuration

Two policies are per-project configuration, stored on the runtime group /
project binding record and editable from the Podium web UI:

| Setting | Default | Meaning |
|---|---|---|
| `plan_approval_required` | `false` | When `true`, every issue waits for a human to approve the plan before execution. When `false`, the plan schema is the gate and execution proceeds; only work items with `needs_human_approval: true` still pause. |
| `plan_validation_retry_limit` | `2` | Failed plan-validation attempts before the harness escalates to a human via `open_questions` instead of retrying. |

Per-work-item `needs_human_approval` always pauses that work item regardless of
`plan_approval_required`.

## What This Removes

| Removed | Replacement |
|---|---|
| DAG node scheduler, predicate state machine | harness drives work items in order; agent parallelizes internally |
| aggregate parent nodes + dual dependency policy | linear work-item dependencies, harness verifies each |
| standalone plan/execute/verify node projection | one run, work-item boundaries |
| mode capacity | none (one issue, one run) |
| eleven graph node states | small Conductor state set + free-form agent state |
| scattered Linear writers | single Linear Projector |

## Role Placement

The harness is a new run controller inside Conductor, replacing the pipeline
scheduler. Performer degrades to a load-bearing implementation of an
`AgentBackend` — it no longer owns three independent fenced modes. The
import-boundary invariant is unchanged: `performer_api` holds the shared
contracts (plan schema, work-item result schema, canonical events, Conductor
state), and `conductor`, `performer`, `podium` continue not to import one
another.
