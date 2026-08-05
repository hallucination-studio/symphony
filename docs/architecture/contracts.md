# Contracts and Interfaces

| Status | Owns | Does not own |
|---|---|---|
| target proposal | minimal public boundary values and closed outcomes | workflow transitions, Markdown layout, or provider implementation |

Public contracts contain normalized data only. SDK objects, process handles,
credentials, arbitrary provider metadata, raw trajectories, Git object IDs, and
command output stay inside their owning adapters or the local evidence plane.

## Public interfaces

| Interface | Responsibility |
|---|---|
| `LinearGateway` | normalized Root, Root State, new-comment, unfinished-descendant, and projection operations |
| `RootReconciler` | current Root snapshot to one next-Cycle, completion, or human-gate decision |
| `Performer` | mechanically launch one configured Agent CLI process |
| `CycleRunner` | Execute then Audit and calculate the Cycle result |
| Conductor PR function | after completion, run one fixed commit/push/create-PR sequence |

There is no generic Task Manager, capability matrix, MCP command schema,
delivery subsystem, finalizer, runtime registry, or revision-aware mutation
interface.

## Identity and status

```text
RootIssueId = provider string
CycleIssueId = provider string
ExecuteIssueId = provider string
AuditIssueId = provider string
CommentId = provider string
AgentKind = codex

IssueStatus = todo | active | completed | canceled
CycleResult = succeeded | rejected | failed
AuditVerdict = accepted | incomplete | blocked | violation | process_error
```

Provider IDs identify Linear resources. `cycle_number` is display order only.
There is no application revision, seal, content digest, mutation version, or
derived resource identity.

## Launch contract

```text
HarnessRunRequest {
  linear_root: string,
  workspace_path: string,
  run_directory: string,
  agent: codex,
  model: string,
  reasoning_effort: string,
  max_cycles: positive integer
}
```

| Contract | Constraint |
|---|---|
| Root | one identifier or UUID is required; no local task mode or Root discovery |
| workspace | caller supplies one existing isolated Git workspace already bound to the Root |
| run directory | caller supplies one writable directory outside the workspace for checkpoint and evidence files |
| Agent configuration | `--agent` is required; v1 accepts only `codex`, and one selection/configuration applies to all three fresh sessions |
| cycle limit | one `max_cycles` value; no round alias or second budget input |

Root mode is the only public execution entry. Tests and diagnostics exercise
the same internal Cycle Runner, Gateway, prompt, and Performer boundaries
without a second CLI that can mutate one role outside the serial workflow.

## Linear values

```text
LinearIssue {
  id, identifier, title, description, url,
  status, parent_id, team_id, creator_id
}

LinearComment {
  id, issue_id, body, creator_id, created_at
}

LinearWorkflow {
  team_id,
  todo_status_id,
  active_status_id,
  completed_status_id,
  canceled_status_id
}

RootState {
  workspace_path,
  run_directory,
  root_branch,
  current_phase,
  task_state_markdown,
  pending_finding?,
  harness_feedback?,
  comment_cursor?,
  pull_request_url?
}
```

`task_state_markdown` contains only facts promoted from Succeeded Cycles.
`pending_finding` is the single current Rejected or Failed outcome that the next
Reconcile must address; later terminal failures replace it. `harness_feedback`
is one current bounded operational warning, not history or verified progress.
External responses are validated at the Gateway. Root Reconcile receives the
Root, Root State, and comments after `comment_cursor`; it never receives a
workspace summary or complete child snapshot. Descendants are listed only as
`{ id, status }` for mechanical startup cancellation.

`max_cycles` is an in-memory bound for one explicitly launched process, not a
durable workflow field. Removing it from Root State avoids turning an operator
run limit into long-lived task state. A later launch supplies its own bound;
Cycle numbers remain display order in frozen Cycle records.

## Cycle contract

```text
CycleSpec {
  cycle_number,
  objective,
  acceptance,
  boundaries,
  consumed_comment_ids[]
}
```

| Constraint | Meaning |
|---|---|
| one objective | one Execute session can attempt one observable outcome |
| acceptance | one fresh read-only Audit can check it against the real workspace |
| boundaries | explicit in-scope and out-of-scope limits |
| consumed comments | IDs only; bodies are already copied into the rendered Cycle contract where relevant |
| frozen family | harness never updates Cycle, Execute, or Audit title/description after creation |

Task state is not duplicated into `CycleSpec`; Cycle Runner supplies the frozen
Root State snapshot to Execute and Audit. The contract has no executor route,
Audit-reference selection, graph, revision chain, or relation subsystem.

## Root Reconcile contract

```text
RootReconcileRequest {
  root,
  root_state,
  new_root_comments[]
}

RootReconcileDecision =
  | { kind: create_cycle, cycle: CycleSpec }
  | { kind: complete, summary }
  | { kind: needs_human, reason, question? }
```

Reconcile has no workspace mount, workspace tools, Linear capability, or PR
credentials. A `complete` decision is a recommendation: Conductor must perform
the final Inbox check and terminal PR function before setting Root `Done`.

## Performer contract

```text
PerformerLaunchRequest {
  agent: codex,
  model,
  reasoning_effort,
  prompt,
  working_directory,
  sandbox: no_workspace | read_only | workspace_write,
  final_response_path?,
  timeout_ms
}

PerformerProcessResult {
  launch_status: exited | timed_out | start_failed | interrupted,
  exit_code?,
  duration_ms,
  final_response_ref?,
  sanitized_reason?
}
```

Performer returns process facts and, only when the caller requests capture, a
reference to one bounded final response needed by the owning parser. Root
Reconciler requests and parses Manager output; Cycle Runner requests and parses
only Audit output. Execute supplies no response path, so its final output is not
captured, parsed, or projected. Performer never returns or requires a complete
trajectory. Exit code zero does not imply semantic success.

## Role and Cycle results

```text
AuditRunResult =
  | {
      verdict: accepted | incomplete | blocked | violation,
      summary,
      checks[],
      evidence[],
      findings[],
      task_state_markdown?,
      pending_finding?
    }
  | { verdict: process_error, reason }

CycleTerminalResult {
  result: succeeded | rejected | failed,
  audit_issue_id,
  audit_verdict,
  reason
}
```

There is no semantic Execute result contract. The Execute comment projects only
`PerformerProcessResult` facts such as launch status, exit code, duration, and a
sanitized process reason. Execute model prose is untrusted and adds no evidence
that Audit cannot obtain from the frozen contract and real workspace, so it is
never parsed, copied to Linear, or supplied to Audit.

| Result | Required Audit verdict |
|---|---|
| `succeeded` | `accepted` |
| `rejected` | `incomplete` |
| `failed` | `blocked`, `violation`, or `process_error` |

Audit is attempted after every Execute process outcome. Its verdict alone maps
to the Cycle result, so an Execute timeout, nonzero exit, or start failure does
not pre-judge workspace correctness. Only `succeeded` replaces
`task_state_markdown` and `pending_finding` with Auditor-supported values.
Rejected or Failed replaces `pending_finding` with one bounded current failure
summary.

`CycleTerminalResult` remains as a concise operator projection: it lets a human
read the Cycle without traversing Execute and Audit descendants. It is produced
mechanically from the Audit verdict, contains no copied evidence or independent
judgment, and is never input to Root Reconcile. Conductor promotes its trusted
fields into Root State; Root Reconcile reads Root State only.

Root comments use the normalized `LinearComment` value directly. A comment
remains pending until Cycle, Execute, and Audit exist and the local Cycle record
durably contains its ID. Reading or selecting it does not consume it.

## Root workspace and PR publication

```text
PullRequestResult =
  | { status: created, pull_request_url, root_branch }
  | { status: failed, step: validate | commit | push | create_pr, reason }
```

The Conductor PR function makes one ordered attempt after a completion
recommendation, an empty final Inbox read, and no active Cycle. It stages the
Root workspace, requires a non-empty change, creates one commit, pushes the Root
branch, and creates one pull request. It does not return or compare commit
hashes.

Before external commands it records phase `publishing`. An interrupted
publication with no recorded URL becomes `NeedsHuman` on the next process; it
is not retried or inspected automatically. Ordinary failure also leaves Root
nonterminal and retains the workspace and local logs. There is no delivery
record, convergence readback, rollback, branch repair, or existing-PR adoption.

Failures use the closed result variants above or stop with a bounded sanitized
reason and available Root/Cycle/role identity. There is no cross-system error
taxonomy. Failures never carry credentials, prompts, raw model output, file
contents, Git object IDs, or arbitrary provider payloads.
