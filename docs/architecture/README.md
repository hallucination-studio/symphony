# Symphony Target Architecture

| Status | Owns | Does not claim |
|---|---|---|
| target proposal | Linear Root / immutable Cycle workflow, Conductor ownership, and Podium Desktop local orchestration | current implementation parity or an implicit migration sequence |

## Product goal

Symphony uses one long-lived Linear Root Issue as its control plane and advances
it through immutable, single-step Cycles.

```mermaid
%% source-rules: WF-TOPO-001 WF-TOPO-002 WF-TOPO-003 WF-ROUTE-006 WF-INBOX-004
flowchart TD
  Root[Linear Root Issue] --> Reconcile[Root Reconcile]
  Reconcile --> Cycle[Immutable CycleSpec]
  Cycle --> Artist[Artist Issue<br/>fresh workspace-write session]
  Artist --> Critic[Critic Issue<br/>fresh read-only session]
  Critic --> Result[Role descriptions + two Cycle comments + uploaded Critique JSON]
  Result --> State[Trusted fields in Root State]
  State --> Reconcile
  Inbox[New Root comments] --> Reconcile
  Reconcile -->|complete| Delivery[Root Reconcile Delivery<br/>PR, branch, or files]
  Delivery --> Done[Root Done]
```

Each Cycle contains exactly one Artist and one Critic Issue. Critic runs after
every Artist attempt, including process failures. Only a Succeeded Cycle can
update the trusted fields in Root State.

Podium Desktop is the local operator surface for V2. It persists Project
Bindings, derives Root paths, then runs multiple local Conductors. A
Conductor remains a deliberately narrow CLI process for exactly one Root,
exactly one workspace, and exactly one external run directory. Podium owns
local queueing and process lifecycle around those Conductor invocations; it
does not own Cycle semantics, Root State, role prompts, or Critic judgment.

## Reading order

1. Read [Workflow Model](workflow-model.md). Its tables own cross-role state,
   routing, failure, input consumption, and persistence.
2. Read only the named-concern owner relevant to the change.
3. Treat the architecture as the target, not as a description of current code.

| Concern | Owner | Content |
|---|---|---|
| workflow | [Workflow Model](workflow-model.md) | topology, canonical Linear statuses, lifecycle, outcomes, routing, failure, persistence |
| Root semantics | [Root Reconciliation](root-reconciliation.md) | trusted Root State fields, Inbox, next-Cycle choice |
| Linear documents | [Root Issue Model](root-issue.md) | Issue hierarchy, managed descriptions, comments |
| runtime | [Conductor](conductor.md) | CLI, serial loop, Cycle lifecycle, shutdown |
| process boundary | [Performer](performer.md) | mechanical Agent CLI launch and process capture |
| provider boundary | [Task Management](task-management.md) | injectable Linear Gateway and projection |
| workspace and delivery | [Root Workspace and Pull Request](workspace.md) | Root workspace, role access, PR-first delivery with pushed-branch fallback |
| public types | [Contracts](contracts.md) | closed inputs, outputs, and terminal outcomes |
| implementation order | [Roadmap](roadmap.md) | incremental delivery and black-box gates |

## Ownership

| Owner | Owns | Must not own |
|---|---|---|
| Root Reconciler | Prepare the Root workspace, choose one small `CycleSpec`, and produce final Delivery from promoted Critic fields | Linear calls, Critic judgment, or active-Cycle changes |
| Cycle | immutable objective, acceptance, boundaries, and consumed Root comment IDs | long-lived Root state or later input |
| Cycle Runner | Artist/Critic order, exact role Markdown capture, Critique JSON result, and mechanical Cycle file-link projection | next-step invention or Root State mutation |
| Performer | mechanically start one configured Agent CLI process and capture its process output | prompts, semantic interpretation, routing, Linear, or trust decisions |
| Linear Gateway | normalized GraphQL reads/writes, canonical status resolution, and Issue projection behind an injectable protocol | workflow reasoning, Markdown policy, or hidden state |
| Root State | persist the minimal checkpoint and promote trusted fields only from Succeeded Cycles | original requirement, child history, or a Trusted State service |
| Conductor | deterministic serial orchestration, validation, persistence, visible status projection, and startup cancellation | semantic next-step, Critic judgment, Git/worktree/delivery execution, or recovery protocol |
| Podium Desktop | persist Bindings, derive paths, queue without preemption, supervise Conductors, and authorize Linear | Cycle semantics, Root State, role prompts, Critic judgment, Web, or cross-machine leases |

## V1 boundaries

| Included | Excluded |
|---|---|
| one Root and at most one active Cycle | concurrent Cycles or multiple Roots per process |
| exactly one Artist and one Critic per Cycle | planning stage, DAG, parallel work, or subagents |
| one terminal report appended to each Artist/Critic description, plus exactly one Cycle creation and one terminal comment | changing a Cycle title or description after creation |
| one exact Harness-managed checkpoint suffix on Root description | treating generated state as Root requirement or introducing a second checkpoint |
| six canonical Root statuses, with `Needs Human` excluded from descendants | inferred mappings or editing/deleting user-defined state definitions |
| new Root comments become next-Reconcile input | old-comment replay or descendant comments as instructions |
| Root State locates the existing workspace after restart | Agent-session resume, state reconstruction from children, or replacement workspace |
| startup cancels all unfinished descendants before fresh Reconcile | continuing, reviewing, or interpreting old active children |
| Root Reconcile Prepare adopts the current checkout or creates the supplied preferred worktree; caller supplies an external run directory | worktree creation inside Conductor or per-Cycle workspaces |
| Root Reconcile returns one PR, branch, or files Delivery before Root Done | delivery subsystem, retry/finalizer/convergence, automatic merge |
| one public Root-run command | one-shot role commands or any second Linear mutation path |

The harness never modifies a created Cycle title or description and does not
detect unrelated manual edits. It owns only the exact Root snapshot block and
one terminal append to each Artist/Critic description. Root Reconcile receives
the Root requirement after the snapshot block is stripped, Root State (including
the parsed `latest_critique` fields), and new Root comments. Workspace access never
lets it replace Critic judgment. Each Artist and Critic prompt requires its role to finish with one
Markdown result at the prescribed local `cycle-NNN-*-result.md` path. Conductor
appends the exact Artist Markdown to the Artist description and exact Critic
Markdown to the Critic description, each with one human-readable local `Updated at` line;
neither role report is copied to the Cycle.
There is no second summarization or format-repair Agent call.

Artist Markdown is untrusted process output and remains display-only. Critic
Markdown contains a compact machine envelope and a free human audit. Conductor
parses the envelope once, serializes the full typed artifact once to
`cycle-NNN-critique-result.json`, writes/uploads the same bytes, and promotes
only the compact checkpoint into `RootState.latest_critique`. Cycle comments
contain the creating rationale and terminal/upload facts plus a link to the
uploaded file or the current upload error. Upload failure is visible but
does not change the Critic verdict. Reconcile never reads the Cycle DAG, Artist
or Critic descriptions, comments, reports, or transcripts.

The caller-provided external run directory is also the private diagnostic plane.
Bounded raw Agent JSONL/stderr and causal error context may be retained there
with local permissions, with a mechanical `thread_id` index and opaque local
references. This evidence is never supplied to Critic or Root Reconcile, never
uploaded to Linear, and never treated as workflow authority. The caller owns
retention; golden E2E failures archive evidence before cleaning their owned
local/branch resources, preserve the Linear Root tree for inspection, and report
only `diagnostic_ref`. Only a visibly verified successful fixture is archived.

## Podium Desktop V2 boundary

Podium Desktop persists one `ProjectBinding` per configured Linear Project. A
binding contains the project ID, an operator-visible routing label, repository
path, base branch, local concurrency, optional completed-workspace retention,
and independent Reconcile, Artist, and Critic role launch configuration. Root
workspace and run paths are derived from the app-data root and Root ID; Root
State becomes the sole durable binding after Prepare. Assignment records,
process IDs, derived paths, and the pending queue are runtime memory only.

Podium Desktop owns the Linear authorization session for exactly one built-in
OAuth2 application: authorization code with PKCE and `actor=app`, so Symphony
writes are authored by the application bot and never by a personal account.
Tokens live only in a private credentials file in the app-data directory,
Desktop refreshes them in place, and each Conductor launch receives the current
access token in its environment. Codex is the single fixed Agent; optional
per-role connection, model, and reasoning overrides remain direct launch
configuration rather than an agent catalog.

The scheduler is local to one Desktop instance. Waiting Roots are ordered by
Linear priority, creation time, and ID, but never automatically preempt a
running Root. Stop and completed-workspace cleanup are explicit operator
actions; an enabled retention limit may remove only older completed workspaces.
First run is one Binding flow: connect Linear, select a Project, select a
repository, and accept local Codex defaults. Per-role connection, model, and
reasoning overrides live under Advanced. The primary view is organized around
Running, Waiting, Needs attention, and Recently completed Roots rather than
slots. Root rows explain queue position or the latest event and provide direct
actions to open Linear, workspace, delivery, and private diagnostics. Raw local
paths remain behind those actions.
There is no cross-machine lease, distributed claim, SQLite store, daemon IPC,
or Web surface in this V2 target. Podium recognizes a replied `Needs Human`
Root as an ordinary candidate while keeping the existing priority/creation/ID
order. It renders status only and exposes no answer or Resume surface.
