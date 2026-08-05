# Linear Boundary

| Status | Owns | Does not own |
|---|---|---|
| target proposal | small injectable Linear Gateway, GraphQL implementation, Issue projection, Root State, and Root comment cursor | semantic routing, full-tree reconstruction, Agent context, or generic capabilities |

`LinearGateway` is the only Linear boundary. There is no generic Task Manager,
MCP schema, caller capability, mutation basis, resource revision, or provider
SDK value in public contracts.

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
  list_root_comments_after(root_id, cursor?) -> LinearComment[]
  find_root_state_comment(root_id) -> LinearComment?
  list_unfinished_descendants(root_id) -> { id, status }[]
  create_issue(request) -> LinearIssue
  update_issue_status(issue_id, status_id) -> void
  create_comment(issue_id, body) -> LinearComment
  update_comment(comment_id, body) -> void
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

## Discovery

| Input | Required result |
|---|---|
| Root identifier such as `TEAM-123` | one exact existing Root and its team |
| Root UUID | the same normalized Root shape |
| Root team | four semantic states: waiting, active, completed, canceled |
| Root State marker | zero or one Harness-owned State comment |

Caller-provided team, project, state, label, and template IDs are not inputs.
State resolution uses provider state types; it does not require ten custom
workflow names.

## Projection

| Operation | Required behavior |
|---|---|
| initialize Root | create first Root State comment after supplied paths pass validation |
| startup abandonment | cancel every item returned by `list_unfinished_descendants` |
| create family | create Cycle, Execute, Audit in order with correct parents |
| append results | write Execute process facts, the Audit report, or the mechanical Cycle summary to the matching Issue |
| update role status | use one of four discovered semantic states |
| update Root State | mutate only the marked Harness State comment |

Cycle, Execute, and Audit titles/descriptions are never updated after creation.
Agent sessions never receive a Gateway.

## Root State policy

Root State is the durable runtime checkpoint and contains only:

- Root workspace path, external run directory, and branch;
- current phase or `NeedsHuman` reason;
- current task state and one pending finding;
- at most one current Harness warning;
- Root comment cursor;
- final PR URL when created.

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
| Root already `Done` | no provider mutation |
| manual edit to frozen child description | v1 does not detect or repair it |

`LINEAR_API_KEY` is read only by the production GraphQL factory. It never enters
Agent requests, browser responses, logs, fixtures, errors, or final reports.
