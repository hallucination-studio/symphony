# Linear Boundary

| Status | Owns | Does not own |
|---|---|---|
| target proposal | small injectable Linear Gateway, GraphQL implementation, Issue projection, Root State, and Root comment cursor | semantic routing, full-tree reconstruction, Agent context, or generic capabilities |

`LinearGateway` is the only Linear boundary. There is no generic Task Manager,
MCP schema, caller capability, mutation basis, resource revision, or provider
SDK value in public contracts.

`attach_file` is the sole result-file upload operation. It receives the Cycle
Issue ID, the exact `cycle-NNN-audit-result.json` filename as title and
filename, content type `application/json`, and the local file bytes as
`Uint8Array`; it returns only a normalized uploaded file `{ url }`. Role
Markdown is comment-only. JSONL, stderr, prompts, and arbitrary provider
payloads are never uploaded.

## Minimal implementation

| Part | Owns | Must not own |
|---|---|---|
| Gateway protocol and GraphQL implementation | typed calls, response validation, timeouts, secret redaction | workflow decisions or Markdown policy |
| projector/templates | create Cycle family, append results, update statuses and Root State | direct HTTP or Agent invocation |
| Inbox helper | read comments after Root State cursor and filter Harness markers | active-Cycle injection or old-comment replay |

Only `LinearGateway` is an architectural interface. Projection, templates, and
Inbox filtering are private functions and may share files; they must not become
services, plugin points, or public interfaces.

## Gateway protocol

```text
LinearGateway {
  get_issue(issue_ref) -> LinearIssue
  list_team_states(team_id) -> LinearWorkflowState[]
  create_team_state(team_id, name, type) -> LinearWorkflowState
  list_root_comments_after(root_id, cursor?) -> LinearComment[]
  find_root_state_comment(root_id) -> LinearComment?
  list_unfinished_descendants(root_id) -> { id, status }[]
  create_issue(request) -> LinearIssue
  update_issue_status(issue_id, status_id) -> void
  create_comment(issue_id, body) -> LinearComment
  update_comment(comment_id, body) -> void
  upload_file(filename, content_type: "application/json", contents: Uint8Array) -> LinearUploadedFile
}
```

| Contract | Constraint |
|---|---|
| every call | async typed normalized values with bounded production timeout |
| response | validate external GraphQL shape before returning |
| error | bounded operation/resource identity; no key, auth header, or raw secret payload |
| tests | pure in-memory fake, no credentials or network |
| orchestration | depends only on Gateway, never concrete GraphQL or SDK objects |

There is intentionally no `readRootFamily` operation. Unfinished descendant
listing exposes only the fields required for mechanical cancellation.

## Canonical status discovery

| Input | Required result |
|---|---|
| Root identifier such as `TEAM-123` | one exact existing Root and its team |
| Root UUID | the same normalized Root shape |
| Root team | five canonical statuses: `Todo`/`unstarted`, `In Progress`/`started`, `In Review`/`started`, `Done`/`completed`, `Canceled`/`canceled` |
| Root State marker | zero or one Harness-owned State comment |

The caller provides no team or workflow-state IDs. The Gateway reads the Root's
team and resolves the five canonical statuses by exact name and expected type;
the resulting provider IDs stay inside Conductor's projection boundary. It does
not use type uniqueness, list order, fuzzy names, or provider defaults to assign
meaning.

Startup handles each canonical name/type pair as follows:

| Discovery result | Required behavior |
|---|---|
| exactly one exact-name state with the expected type | bind its ID |
| no exact-name state | create the exact name/type, then bind the returned ID |
| one or more exact-name states with a wrong type | stop before an Agent starts or any Issue mutation |
| more than one exact-name state, even when one has the expected type | stop before an Agent starts or any Issue mutation |
| canonical-state creation fails | expose the provider error and stop before an Agent starts |

Any other user-defined state is ignored completely. Symphony never edits or
deletes those state definitions, never treats another `started` state as
`In Progress` or `In Review`, and never copies their names into public
contracts. The five canonical states are shared by Root, Cycle, Execute, and
Audit. Startup performs this team-level workflow-contract check even when the
Root is already `Done`; creating a missing canonical state does not mutate the
Root or any descendant. An Issue already on the exact canonical `Done` state is
a terminal no-op and is not normalized through another same-named state.

The normalized `LinearIssue.status` is deliberately coarse provider-type data:
`todo`, `active`, `completed`, or `canceled`. It is not a second lifecycle
state machine. Because both canonical active states have provider type
`started`, every lifecycle comparison and update uses the exact canonical
`status_id`; no code infers `In Progress` or `In Review` from `active`.

## Projection

| Operation | Required behavior |
|---|---|
| initialize Root | create first Root State comment after supplied paths pass validation |
| startup abandonment | set every unfinished descendant to canonical `Canceled` before fresh Reconcile |
| create family | create Cycle, Execute, and Audit in `Todo` in order with correct parents and business-aligned titles |
| activate family | after all IDs are persisted, set Cycle and Root to `In Progress` before Execute starts |
| start Execute | set Execute to `In Progress` before launching the process |
| start Audit | set Cycle to `In Review` and Audit to `In Review` before launching the process |
| append results | copy each role Markdown to its own comment; write mechanical Cycle fields and one JSON outcome; errors show the current message's first 50 characters |
| attach results | serialize the parsed Audit result as `cycle-NNN-audit-result.json`, re-read and validate it, then upload that exact file as `application/json`; record its returned URL or current upload error |
| finish role or Cycle | append its bounded result, then set Execute, Audit, or Cycle to canonical `Done` |
| project Root decision | active Cycle -> `In Progress`; `complete`, `needs_human`, or escaped runtime failure -> `In Review`; recorded PR or pushed branch delivery -> `Done` |
| append Root Reconcile result | copy one validated decision report under the Harness marker; mechanically project trusted completion worktree/line/token facts; never feed it back through Root Inbox |
| update Root State | mutate only the marked Harness State comment |

Cycle, Execute, and Audit titles/descriptions are never updated after creation.
Their frozen titles are `[Cycle NNN] <objective>` (maximum 80 characters total),
`[Executor] Cycle NNN`, and `[Audit] Cycle NNN` so each role is visibly aligned
with its business Cycle.
Issue status transitions are explicit Linear mutations and are not replaced by
comments or Root State. Executor/Audit Markdown is what operators see in their
comments; the typed Audit JSON is the only Cycle resource and is the file used
for progression. The Cycle Result links that resource or exposes its current
upload error. No second summarizer is inserted. An upload failure is visible but
does not change the parsed Audit verdict. Agent sessions never receive a
Gateway.

## Root State policy

Root State is the durable runtime checkpoint and contains only:

- Root workspace path, external run directory, and branch;
- current phase or `NeedsHuman` reason;
- current task state and one pending finding;
- complete `latest_audit` from the newest terminal Audit;
- at most one current Harness warning;
- Root comment cursor;
- exact accumulated process token usage when known;
- final PR URL when created, otherwise the successfully pushed delivery branch.

If Root State is missing for a new Root, initialize it. If it is duplicated or
malformed, stop as `NeedsHuman`; do not reconstruct it from descendants. If the
saved workspace is missing, stop rather than creating a conflicting workspace.

## Comment policy

| Fact | Behavior |
|---|---|
| comment is after saved cursor and lacks Harness marker | new Reconcile input |
| comment carries Harness marker | operational output, never model input |
| comment belongs to descendant | display-only, never fetched for Reconcile |
| selected new comment | cursor remains unchanged until complete Cycle family is recorded |
| completion recommendation | perform one final after-cursor read before PR function |

## Failure policy

| Condition | Behavior |
|---|---|
| any provider failure | expose and stop; no alternate task mode or provider fallback |
| partial family | start no Agent; next process cancels unfinished pieces |
| unknown write outcome | stop; do not guess, duplicate, or read back into a recovery protocol |
| Root already `Done` | after the team workflow-contract check, no Root, descendant, comment, workspace, or Agent mutation |
| manual edit to frozen child description | v1 does not detect or repair it |

`LINEAR_API_KEY` is read only by the production GraphQL factory. It never enters
Agent requests, browser responses, logs, fixtures, errors, or final reports.
