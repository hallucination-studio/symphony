# Linear Boundary

| Status | Owns | Does not own |
|---|---|---|
| target proposal | small injectable Linear Gateway, GraphQL implementation, Issue projection, Root State, and Root comment cursor | semantic routing, full-tree reconstruction, Agent context, or generic capabilities |

`LinearGateway` is the only Linear boundary. There is no generic Task Manager,
MCP schema, caller capability, mutation basis, resource revision, or provider
SDK value in public contracts.

Podium Desktop may persist a `ProjectBinding` whose `project_id` identifies a
Linear Project and whose `routing_label` is visible operator configuration.
That binding is a Desktop routing input, not a new Conductor Gateway operation:
Conductor still receives one already-resolved Root identifier and does not list
Projects, claim Roots, or choose a Linear status on Podium's behalf.

`attach_file` is the sole result-file upload operation. It receives the Cycle
Issue ID, the exact `cycle-NNN-critique-result.json` filename as title and
filename, content type `application/json`, and the local file bytes as
`Uint8Array`; it returns only a normalized uploaded file `{ url }`. Role
Markdown is appended once to the terminal role Issue description. JSONL, stderr,
prompts, and arbitrary provider payloads are never uploaded.

## Minimal implementation

| Part | Owns | Must not own |
|---|---|---|
| Gateway protocol and GraphQL implementation | typed calls, response validation, timeouts, secret redaction | workflow decisions or Markdown policy |
| projector/templates | create Cycle family, append terminal reports/history, update descriptions, statuses, Root snapshot, and Root State | direct HTTP or Agent invocation |
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
  list_unfinished_descendants(root_id) -> { id, status }[]
  create_issue(request) -> LinearIssue
  update_issue_status(issue_id, status_id) -> void
  update_issue_description(issue_id, body) -> void
  create_comment(issue_id, body) -> LinearComment
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

`update_issue_description` is a constrained projection operation, not a general
content editor. It accepts only one of these owned writes: replace the suffix
between `# Symphony Harness: Managed Root` and
`# Symphony Harness: End Managed Root`, or append one terminal
Artist/Critic report plus one presentation-only human-readable local `Updated at:
<YYYY-MM-DD HH:mm:ss GMT+/-HH:MM>` line to the matching role description. It
must preserve all frozen bytes outside the owned region and is never used for
Cycle descriptions.

## Canonical status discovery

| Input | Required result |
|---|---|
| Root identifier such as `TEAM-123` | one exact existing Root and its team |
| Root UUID | the same normalized Root shape |
| Root team | five canonical statuses: `Todo`/`unstarted`, `In Progress`/`started`, `In Review`/`started`, `Done`/`completed`, `Canceled`/`canceled` |
| Root description | zero or one canonical Harness-managed snapshot suffix |

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
contracts. The five canonical states are shared by Root, Cycle, Artist, and
Critic. Startup performs this team-level workflow-contract check even when the
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
| initialize Root | append the first managed Root snapshot after supplied paths pass validation |
| startup abandonment | set every unfinished descendant to canonical `Canceled` before fresh Reconcile |
| create family | create Cycle, Artist, and Critic in `Todo` in order with correct parents and business-aligned titles |
| activate family | after all IDs are persisted, set Cycle and Root to `In Progress` before Artist starts |
| start Artist | set Artist to `In Progress` before launching the process |
| start Critic | set Cycle to `In Review` and Critic to `In Review` before launching the process |
| append results | append each exact role Markdown once to its own Issue description; write exactly one Cycle creation rationale and one terminal result; errors show the current message's first 50 characters |
| attach results | serialize the Critique artifact once as `cycle-NNN-critique-result.json`, write and upload the same bytes as `application/json`; record its returned URL or current upload error |
| finish role or Cycle | append its bounded result, then set Artist, Critic, or Cycle to canonical `Done` |
| project Root decision | active Cycle -> `In Progress`; `complete`, `needs_human`, or escaped runtime failure -> `In Review`; recorded PR or pushed branch delivery -> `Done` |
| project Root Reconcile result | place report and Delivery before Metadata; copy `create_cycle` once to Cycle; project trusted result facts; never feed it to Inbox |
| update Root State | replace only the canonical Harness-managed Root description suffix |

Cycle title/description is never updated after creation. Artist and Critic
descriptions are updated exactly once at terminal handling by appending the exact
role report to their frozen context. Their frozen titles are
`[Cycle NNN] <objective>` (concise imperative wording; maximum 80 characters total with word-safe ellipsis fallback), `[Artist] Cycle NNN`, and
`[Critic] Cycle NNN` so each role is visibly aligned with its business Cycle.
Issue status transitions are explicit Linear mutations and are not replaced by
comments or Root State. Artist/Critic Markdown is what operators see in their
terminal Issue descriptions; the two Cycle comments show creation and terminal
upload facts; the typed Critique JSON is the only Cycle resource and is the file
used for progression. The Cycle Result links that resource or exposes its
current upload error. No second summarizer is inserted. An upload failure is
visible but does not change the parsed Critic verdict. Agent sessions never
receive a Gateway.

The Root completion report projects trusted file and line facts, wall-clock run
duration, and short token usage before Delivery and technical Metadata. It is a
visible result projection only and is never fed back through Inbox.

## Root State policy

Root State is the durable runtime checkpoint and contains only:

- Root workspace path, external run directory, and branch;
- current phase or `NeedsHuman` reason;
- current trusted task state;
- compact `latest_critique` checkpoint from the newest terminal Critic;
- at most one current Harness warning;
- Root comment cursor;
- exact accumulated process token usage when known;
- optional structured Delivery.

If Root State is missing for a new Root, initialize it. If it is duplicated or
malformed, stop as `NeedsHuman`; do not reconstruct it from descendants. If the
saved workspace is missing, stop rather than creating a conflicting workspace.

## Comment policy

| Fact | Behavior |
|---|---|
| comment is after saved cursor and lacks Harness marker | new Reconcile input |
| comment carries Harness marker | operational output, never model input |
| comment belongs to descendant | display-only, never fetched for Reconcile |
| Cycle creation/result comment | exactly two append-only operator records; never model input |
| selected new comment | cursor remains unchanged until complete Cycle family is recorded |
| completion decision | perform one final after-cursor read before persisting Root Reconcile Delivery |

## Failure policy

| Condition | Behavior |
|---|---|
| any provider failure | expose and stop; no alternate task mode or provider fallback |
| partial family | start no Agent; next process cancels unfinished pieces |
| unknown write outcome | stop; do not guess, duplicate, or read back into a recovery protocol |
| Root already `Done` | after the team workflow-contract check, no Root, descendant, comment, workspace, or Agent mutation |
| manual edit to frozen child description | v1 does not detect or repair it |

## Credential boundary

Symphony acts in Linear only as one built-in application bot, never as a
personal account and never as an operator-supplied application. The Linear
OAuth2 application is created once by the Symphony team; its public
`client_id` is build-time configuration injected into Desktop, and no client
secret exists anywhere in the product. Authorization is the authorization-code
flow with PKCE and `actor=app`, scoped to `read`, `write`, `app:assignable`,
and `app:mentionable`, so every Symphony write is authored by the application.
Desktop holds one Linear connection per instance; its own candidate polling
and every Conductor it launches use the same current token.

| Rule | Required behavior | Forbidden behavior |
|---|---|---|
| `TM-CRED-001` | use exactly one built-in Linear application whose public `client_id` is injected at build time | operator-supplied applications, custom accounts, or an embedded client secret |
| `TM-CRED-002` | authorize with the system browser, PKCE, a loopback redirect, and `actor=app` with the fixed scope set | embedded login views, personal API keys, or user-actor writes |
| `TM-CRED-003` | store OAuth tokens only in one private credentials file (0600) under the Desktop app-data directory | tokens in `state.json`, bindings, logs, diagnostics, IPC payloads, or Linear data |
| `TM-CRED-004` | refresh the access token inside Desktop on expiry, replaying within the provider grace window on network failure | refresh capability outside Desktop, or silent indefinite retries |
| `TM-CRED-005` | inject the current access token into each Conductor as `LINEAR_API_KEY` at launch | refresh tokens or credentials-file access in child processes |
| `TM-CRED-006` | validate on connect by reading the organization and show that real state in Settings | marking the connection healthy from stored values alone |
| `TM-CRED-007` | treat lost local credentials as a fresh connect; the Linear-side grant persists and re-authorization mints new tokens | repair protocols, token recovery, or Linear-side cleanup after local data loss |

No credential ever enters Agent requests, browser responses, logs, fixtures,
errors, or final reports. The credentials file follows the same-user threat
model of local CLI tools: private permissions are the whole defense, and
rotating the grant in Linear invalidates it. An access token covers one day;
a Conductor run that outlives it fails visibly and relaunches with a fresh
token. When the connection is missing or rejected, Desktop surfaces a
connect-or-reconnect action instead of a restart-only dead end. A manual Conductor launch supplies
an app-actor token for the same built-in application; personal API keys are
rejected.
