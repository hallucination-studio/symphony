# Contracts and Interfaces

| Status | Owns | Does not own |
|---|---|---|
| target proposal | minimal public boundary values and closed outcomes | workflow transitions, Markdown layout, or provider implementation |

Public semantic contracts contain normalized data only. SDK objects, process
handles, credentials, arbitrary provider metadata, raw trajectories, Git object
IDs, and command output stay inside their owning adapters or the private local
evidence plane. A diagnostic reference is an opaque local pointer, never
semantic evidence.

## Public interfaces

| Interface | Responsibility |
|---|---|
| `LinearGateway` | normalized Root, Root State, managed-description, new-comment, unfinished-descendant, comment, and uploaded-file projection operations |
| `RootReconciler` | Prepare a workspace, choose the next Cycle, or return final structured Delivery/human gate |
| `Performer` | mechanically launch one configured Agent CLI process |
| `CycleRunner` | Artist then Critic and calculate the Cycle result |
| Conductor projection | validate and persist Root Reconcile output, then project Linear description/status |
| `ProjectBinding` | persisted Podium Desktop routing, repository, concurrency, and role launch values |

There is no generic Task Manager, capability matrix, MCP command schema,
delivery subsystem, finalizer, runtime registry, cross-machine lease, or
revision-aware mutation interface. Podium Desktop runtime assignments, process
IDs, and queue entries are not public or durable contracts.

## Identity and status

```text
RootIssueId = provider string
CycleIssueId = provider string
ArtistIssueId = provider string
CriticIssueId = provider string
CommentId = provider string
AdrNumber = ADR-NNNN, mechanically assigned per Root
LocalTimestamp = YYYY-MM-DD HH:mm:ss GMT+/-HH:MM
AgentKind = codex

LinearStateType = unstarted | started | completed | canceled
IssueStatus = todo | active | completed | canceled
CycleResult = succeeded | rejected | failed
CritiqueVerdict = accepted | incomplete | blocked | violation | process_error
```

Provider IDs identify Linear resources. `cycle_number` is display order only.
There is no application revision, seal, content digest, mutation version, or
derived resource identity.

`IssueStatus` is only a coarse provider-type projection for transport and
terminal filtering. It cannot distinguish `In Progress` from `In Review`
because Linear assigns both the `started` type. Lifecycle decisions therefore
use the exact canonical `status_id` resolved by name and expected type; they
never infer a canonical state from `IssueStatus`.

## Launch contract

```text
HarnessRunRequest {
  linear_root: string,
  workspace_path?: string,
  run_directory: string,
  reconcile_agent: codex,
  reconcile_model?: string,
  reconcile_reasoning_effort?: string,
  artist_agent: codex,
  artist_model?: string,
  artist_reasoning_effort?: string,
  critic_agent: codex,
  critic_model?: string,
  critic_reasoning_effort?: string,
  max_cycles: positive integer
}
```

| Contract | Constraint |
|---|---|
| Root | one identifier or UUID is required; no local task mode or Root discovery |
| workspace | optional preferred absolute path; Root Reconcile Prepare creates/adopts it, or adopts current directory when omitted |
| run directory | caller supplies one writable directory outside the workspace for checkpoint and evidence files |
| Reconcile role | `--reconcile-agent` is `codex`; model and reasoning overrides are optional |
| Artist role | `--artist-agent` is `codex`; model and reasoning overrides are optional |
| Critic role | `--critic-agent` is `codex`; model and reasoning overrides are optional |
| role configuration | Reconcile, Artist, and Critic launch values are independent; no role inherits another role's model or reasoning setting |
| cycle limit | one `max_cycles` value; no round alias or second budget input |

Root mode is the only public execution entry. Tests and diagnostics exercise
the same internal Cycle Runner, Gateway, prompt, and Performer boundaries
without a second CLI that can mutate one role outside the serial workflow.

Role API keys and base URLs are startup environment inputs resolved by the
Conductor backend, not public contract fields or Project Binding fields.
Role-specific values use `SYMPHONY_RECONCILE_CODEX_API_KEY`/
`SYMPHONY_RECONCILE_CODEX_BASE_URL`,
`SYMPHONY_ARTIST_CODEX_API_KEY`/`SYMPHONY_ARTIST_CODEX_BASE_URL`, and
`SYMPHONY_CRITIC_CODEX_API_KEY`/`SYMPHONY_CRITIC_CODEX_BASE_URL`. When no
role-specific value is resolved, Performer injects no key or base URL and the
fresh Codex CLI uses the user's local `~/.codex` configuration and
authentication unchanged. No capability matrix or default model/effort is
hardcoded.

The Linear credential follows the same boundary: a Podium-launched process
receives the current app-actor access token as the `LINEAR_API_KEY`
environment value at startup. OAuth tokens and the credentials file are never
contract fields, `ProjectBinding` values, Linear data, log lines, or
diagnostic content.

## Podium Desktop values

```text
RoleLaunchConfig {
  agent: codex,
  model?: string,
  reasoning_effort?: string
}

ProjectBinding {
  project_id: string,
  routing_label: non-empty string,
  repository_path: absolute path,
  base_branch: non-empty string,
  concurrency: positive integer,
  completed_workspace_retention?: positive integer,
  reconcile_agent: codex,
  reconcile_model?: string,
  reconcile_reasoning_effort?: string,
  artist_agent: codex,
  artist_model?: string,
  artist_reasoning_effort?: string,
  critic_agent: codex,
  critic_model?: string,
  critic_reasoning_effort?: string
}
```

The three flattened role groups in `ProjectBinding` normalize to independent
`RoleLaunchConfig` values at launch. `project_id` identifies a Linear Project;
`routing_label` is visible Desktop configuration, not a hidden Linear status.
Only Project Bindings persist locally. Root workspace/run paths are
deterministically derived at assignment time and become durable only in Root
State after Prepare; assignment, path, PID, and queue values are otherwise
runtime state. The binding carries no key, cookie, token, base URL, process
handle, or arbitrary provider object. Codex is fixed directly; optional
per-role connection overrides live in the private startup environment rather
than an agent catalog or public contract.

## Linear values

```text
LinearIssue {
  id, identifier, title, description, url,
  status, status_id, parent_id, team_id, creator_id
}

LinearWorkflowState {
  id, name, type: LinearStateType
}

LinearComment {
  id, issue_id, parent_id, body, creator_id, created_at
}

HumanActionQuestion {
  question,
  options[{ key, label, consequence }]
}

HumanActionState {
  comment_id: CommentId,
  reply_cursor?: CommentId
}

ArchitectureDecision {
  id: AdrNumber,
  title,
  decision,
  rationale,
  consequences[],
  source_action_comment_id: CommentId,
  source_reply_ids[],
  decided_at: LocalTimestamp
}

ArchitectureDecisionDraft {
  title,
  decision,
  rationale,
  consequences[]
}

LinearUploadedFile {
  url
}

LinearWorkflow {
  team_id,
  todo_status_id,
  in_progress_status_id,
  in_review_status_id,
  done_status_id,
  canceled_status_id
}

RootState {
  workspace_path,
  run_directory,
  root_branch,
  current_phase,
  task_state_markdown,
  latest_critique?: CritiqueCheckpoint,
  harness_feedback?,
  comment_cursor?,
  human_action?: HumanActionState,
  architecture_decisions[]: ArchitectureDecision,
  delivery?: Delivery,
  token_usage?: PerformerTokenUsage
}
```

`LinearWorkflow` is an internal Gateway result, not a `HarnessRunRequest`
field. Its five IDs are bound only after exact-name and expected-type checks;
the caller never supplies status IDs or CLI flags.

The Gateway's description operation is constrained to replacing the exact
interior of the Root Harness snapshot block or appending one terminal `# Result`
region plus one human-readable local `Updated at: <YYYY-MM-DD HH:mm:ss GMT+/-HH:MM>`
line to an Artist/Critic description. Child descriptions separate frozen
`# Task`, Harness-owned `# Symphony Metadata`, and optional terminal `# Result`
regions. It preserves all frozen bytes outside the owned region and cannot
update a Cycle description. The file operation is
`upload_file(filename, content_type: "application/json", contents: Uint8Array)
-> LinearUploadedFile`. It returns only `{ url }`. The once-serialized typed
Critic artifact is uploaded to the Cycle as `cycle-NNN-critique-result.json`; role Markdown
is description-only.
JSONL, stderr, prompts, and arbitrary provider payloads are private and never
uploaded.

`task_state_markdown` contains only facts promoted from Succeeded Cycles.
`latest_critique` contains only the newest verdict, task state, optional pending
finding, and artifact URL; it is the only recent Critic checkpoint supplied to
Root Reconcile. Complete report detail remains in the local/uploaded artifact.
The Cycle DAG and child comments are never reconstructed to fill or replace it.
`harness_feedback`
is one current bounded operational warning, not history or verified progress.
`human_action` is present only while the Root has one unresolved Human Action
request. Its `comment_id` identifies the exact Harness question and
`reply_cursor` locates the last classified direct reply. A
normal top-level Root comment is ordinary Inbox input and cannot answer this
thread, set `reply_disposition`, or clear `human_action`. A missing
`architecture_decisions[]` field is invalid; an empty array is the explicit
no-decision state. Accepted decisions append to this array and are never
edited, renumbered, or removed.

`ArchitectureDecision` is a compact semantic record, not an ADR document. The
Conductor assigns the next `ADR-NNN` mechanically from Root State, records the
runtime-local `YYYY-MM-DD HH:mm:ss GMT+/-HH:MM` value, and copies the action and
reply IDs. Root Reconcile provides only title, decision, rationale, and
consequences. No repository ADR file, compatibility alias, or second decision
store exists.

This is a hard switch: there is no legacy flat Root-reply interpretation and no
compatibility form for a missing `human_action` or `architecture_decisions[]`
boundary. Providers or callers that cannot expose the exact direct-reply thread
fail closed before a Human Action can be accepted.

When a direct reply batch is accepted, the next Reconcile result includes one
or more `ArchitectureDecisionDraft` values with its next semantic decision.
Conductor completes their mechanical fields and persists them only through
`RootState.architecture_decisions[]`. If the next decision creates a Cycle,
Cycle Runner receives the exact append-only array as an immutable snapshot.
External responses are validated at the Gateway. Root Reconcile receives the
Root, Root State, comments after `comment_cursor`, and a typed mechanical
whole-worktree summary containing only paths and line deltas; it never receives
workspace access, file contents, or a complete child snapshot. Descendants are listed only as
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
  consumed_comment_ids[],
  architecture_decisions[]: ArchitectureDecision
}
```

| Constraint | Meaning |
|---|---|
| one objective | one Artist session can attempt one observable outcome |
| acceptance | one fresh read-only Critic can check it against the real workspace |
| boundaries | explicit in-scope and out-of-scope limits |
| consumed comments | IDs only; bodies are already copied into the rendered Cycle contract where relevant |
| architecture decisions | immutable snapshot of every accepted Root decision known before Cycle creation; records retain mechanical ADR number, local time, and source IDs |
| frozen family | harness never updates Cycle title/description; it appends one terminal report to each Artist/Critic description |

Cycle titles use `[Cycle NNN] <objective>` and are capped at 80 characters in
total. Artist and Critic titles are exactly `[Artist] Cycle NNN` and
`[Critic] Cycle NNN`; role titles do not repeat or reinterpret the objective.

Task state is not duplicated into `CycleSpec`; Cycle Runner supplies the frozen
Root State snapshot to Artist and Critic. `architecture_decisions[]` is the
intentional exception: it is copied at Cycle creation so the accepted human
choices that shaped this Cycle remain auditable even after Root State advances.
The snapshot is immutable and cannot be amended by a later reply or role. The
contract has no artist route, Critic-reference selection, graph, revision chain,
or relation subsystem.

## Root Reconcile contract

```text
RootReconcileRequest {
  root,
  root_state,
  new_root_comments[],
  human_action_replies[],
  worktree_summary:
    | { status: available, created[], updated[], deleted[], insertions, deletions }
    | { status: unavailable, reason }
}

RootReconcileDecision =
  | { kind: create_cycle, cycle: CycleSpec, architecture_decisions[]?, report }
  | { kind: complete, summary, delivery: Delivery, architecture_decisions[]?, report }
  | { kind: needs_human, reason, questions[1..n], reply_disposition?, architecture_decisions[]?, report }

RootReconcileOutcome { decision, process? }
```

`architecture_decisions` is present and non-empty only when the exact direct
reply batch was freshly read and accepted as a whole. These are semantic drafts;
Conductor adds IDs, source comment IDs, and local timestamps. A rejected batch
has no decision drafts. Ordinary top-level Root comments remain
`new_root_comments[]` Inbox input and never satisfy a pending Human Action or
set `reply_disposition`.

Reconcile has workspace-write access for Prepare and Delivery, but no Linear
capability. Conductor removes the exact managed Root snapshot block before
passing Root. Reconcile reads only the immutable requirement, Root State, and new Root comments; trusted
Critic fields have already been promoted into Root State. It never reads the
Cycle DAG or Artist/Critic content. Root Reconcile runs through its independent
`reconcile_agent`, `reconcile_model`, and `reconcile_reasoning_effort` values.
Artist and Critic use their corresponding role values; startup API keys and base
URLs remain backend environment resolution, and no role inherits another role. A
`complete` decision includes the Root Reconcile-produced Delivery: Conductor
performs the final Inbox check and durable projection before setting Root `Done`.
Every report has a fixed decision-specific Markdown shape. Conductor copies it
once to Root and mechanically replaces completion file/line/token sections with
trusted facts. `process.token_usage` is accumulated with Artist and Critic
usage in Root State; any missing or unsafe invocation makes the total unknown.

## Performer contract

```text
PerformerLaunchRequest {
  agent: codex,
  model?,
  reasoning_effort?,
  prompt,
  working_directory,
  sandbox: no_workspace | read_only | workspace_write | danger_full_access,
  final_response_path?,
  diagnostic_jsonl_path?,
  diagnostic_stderr_path?,
  timeout_ms
}

PerformerProcessResult {
  launch_status: exited | timed_out | start_failed | interrupted,
  exit_code?,
  duration_ms,
  final_response_ref?,
  diagnostic_jsonl_ref?,
  diagnostic_stderr_ref?,
  thread_id?,
  token_usage?: {
    input_tokens,
    output_tokens,
    total_tokens,
    cached_input_tokens?,
    cache_write_input_tokens?,
    reasoning_output_tokens?
  },
  sanitized_reason?
}
```

Performer returns process facts and, only when the caller requests capture, a
reference to one bounded final Markdown response needed by the owning parser. It
may also return private local diagnostic references and a mechanically indexed
`thread_id`; these are not semantic contract values. Root Reconciler requests
and parses Manager output; Cycle Runner requests both role result paths. Artist
Markdown is copied only as untrusted display output; Cycle Runner parses Critic
Markdown once as the sole semantic result. Performer never returns or requires
a complete trajectory. Exit code zero does not imply semantic success, and no
second summarization or format-repair Agent call exists.

Codex `turn.completed.usage` reports cumulative counts for the invocation:
`input_tokens` and `output_tokens` are required, while cached input,
cache-write input, and reasoning output are optional provider subcounts.
`total_tokens` is a mechanical safe sum of input plus output, not a provider
cost or semantic result; the whole usage object is omitted when the required
counts are absent or cannot be added safely. Optional subcounts are never added
again. Unknown JSONL fields and malformed counters are omitted from the public
result and remain only in private diagnostics.

Diagnostic paths and refs retain bounded raw Agent JSONL, stderr, and causal
error context only under the caller-provided external `run_directory`. The
files are private local evidence (0600), not `CritiqueResult`, `RootState`,
`CycleTerminalResult`, or `LinearComment` fields. Raw bytes and `thread_id` are
never supplied to Critic or Root Reconcile and never uploaded to Linear.

## Role and Cycle results

```text
CritiqueEnvelope =
  | {
      verdict: accepted | incomplete | blocked | violation,
      task_state_markdown,
      pending_finding?
    }
  | { verdict: process_error, reason }

CritiqueArtifact {
  envelope: CritiqueEnvelope,
  report_markdown: string
}

CritiqueCheckpoint =
  | {
      verdict: accepted | incomplete | blocked | violation,
      task_state_markdown,
      pending_finding?,
      artifact_url?
    }
  | { verdict: process_error, reason, artifact_url? }

CycleTerminalResult {
  result: succeeded | rejected | failed,
  critic_issue_id,
  critic_verdict,
  reason
}
```

Each Cycle role prompt requires its final response to be Markdown in the last
response position and writes it to a local `cycle-NNN-*-result.md` file. The
Artist report gives a human-readable summary of actual file changes and
verification without a machine-parsed heading schema; it is appended
byte-for-byte once to the Artist description
with one human-readable local `Updated at: <YYYY-MM-DD HH:mm:ss GMT+/-HH:MM>` line and
is never parsed or supplied to Critic. Git porcelain markers (`??`, `M`,
`D`) must be translated to those semantic sections rather than copied verbatim.
The Critic report starts with the compact JSON `CritiqueEnvelope`, then gives a
human-readable audit of scope, implementation logic, checks, evidence, and
findings. It is appended byte-for-byte once to the Critic description with one
human-readable local `Updated at:
<YYYY-MM-DD HH:mm:ss GMT+/-HH:MM>` line. Neither report repeats the Cycle
description. Byte-for-byte describes the Harness write request. Linear may
normalize equivalent Markdown syntax when the description is read back; public
validation therefore requires a valid machine envelope and non-empty report,
not an exact human heading layout or list-marker bytes. Human timestamps are
presentation only and are never parsed as state.

| Result | Required Critic verdict |
|---|---|
| `succeeded` | `accepted` |
| `rejected` | `incomplete` |
| `failed` | `blocked`, `violation`, or `process_error` |

Critic is attempted after every Artist process outcome. Its verdict alone maps
to the Cycle result, so an Artist timeout, nonzero exit, or start failure does
not pre-judge workspace correctness. Only `succeeded` replaces
`task_state_markdown` and `pending_finding` with Critic-supported values.
Rejected or Failed replaces `pending_finding` with one bounded current failure
summary.

`CycleTerminalResult` remains the internal mechanical mapping. The visible Cycle
Result shows only the mapped result, a linked Critic Issue identifier, and the
Critique JSON resource outcome, avoiding repetition of Critic verdict, reason,
or evidence. Each Cycle has exactly one creation rationale and one terminal
result comment; intermediate progress is represented only by Issue statuses.
Their event timestamp is Linear `createdAt`, not a duplicate body timestamp.
Cycle Runner parses the Critic envelope once, creates the typed artifact in
memory, serializes it once to `cycle-NNN-critique-result.json`, and writes/uploads
the same bytes. The JSON file is the only
Cycle uploaded file and uses `application/json`; the Cycle Result links its asset
or reports the current upload error's first 50 characters. Only the validated
compact fields and artifact URL are written to `RootState.latest_critique`
before Reconcile. The
Cycle Result is never direct Reconcile input and Reconcile never reads the Cycle
DAG or either role's content.

Root comments use the normalized `LinearComment` value directly. A comment
remains pending until Cycle, Artist, and Critic exist and the local Cycle record
durably contains its ID. Reading or selecting it does not consume it.

## Root workspace and Delivery

```text
Delivery =
  | { kind: pull_request, url, branch }
  | { kind: branch, branch, remote? }
  | { kind: files, workspace_path, files[] }
```

Root Reconcile produces one Delivery after trusted completion and an empty final
Inbox. It may use Git and `gh`, or return explicit local files. Conductor only
validates and persists this value; it runs no Git command and does not compare
commit hashes.

Any valid Delivery kind permits Root `Done` after the value and visible
`## Delivery` section are durably projected. There is no delivery
record, convergence readback, rollback, branch repair, or existing-PR adoption.

Visible failures use the current boundary's original `error.message` limited to
its first 50 characters, without a prefix, code mapping, or cause traversal.
Full causal context remains in private local diagnostics. Failures never carry
credentials, prompts, raw model output, file contents, Git object IDs, or
arbitrary provider payloads.
