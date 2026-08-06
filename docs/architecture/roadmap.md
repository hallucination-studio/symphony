# V1 Roadmap

| Status | Owns | Does not own |
|---|---|---|
| target proposal | deletion-first implementation order and observable gates | workflow rules or compatibility architecture |

The implementation must hard-cut from the superseded design. Do not build the
new serial loop beside revision, graph, app-server, recovery, or delivery
finalizer code and attempt to keep both paths valid.

## Ordered implementation

| Order | Slice | Required outcome | Check |
|---|---|---|---|
| 1 | delete obsolete implementation and tests | remove every system listed in the permanent subtraction gate and its field-shaped tests | removed-symbol and dependency search |
| 2 | minimal contracts | Root state/compact `latest_critique`, managed snapshot, terminal role descriptions, two Cycle comments, typed Critique JSON, Performer, Gateway, workspace, and Delivery values | focused contract tests |
| 3 | Linear boundary and CLI | injectable Gateway, GraphQL adapter, and one Root-run command | fake Gateway and built CLI scenarios |
| 4 | Root Prepare resources | deterministic Root Reconcile adopts current checkout or creates the preferred worktree without an Agent call; bind its result and external run directory | real Git/filesystem boundary scenario |
| 5 | Root Reconcile and Cycle projection | frozen small-step contract, managed snapshot, terminal role reports, two Cycle comments, typed Critique JSON, and Root/Cycle/Artist/Critic hierarchy | semantic and fake Linear tests |
| 6 | Artist and Critic | fresh workspace-write Artist and distinct fresh read-only Critic each deliver one final Markdown file; Critic remains sole semantic authority, including failed Artist inspection | real Agent CLI boundary tests |
| 7 | Root State and Inbox | save the compact terminal Critic checkpoint as `latest_critique`; promote only `accepted` Critics; checkpoint supplied paths, task state, and comment cursor | focused transaction scenarios |
| 8 | Root Reconcile Delivery | final Inbox check, structured PR/branch/files result, visible projection, then Root Done | real Agent boundary plus three contract scenarios |
| 9 | scenario suite and docs | rebuild tests around reusable business scenarios and prove the complete manual single-machine flow | black-box suite |

Root comment injection starts only after frozen Cycle projection and role
isolation pass. Delivery starts only after trusted Root State gates pass.

## Permanent subtraction gate

These are permanent v1 boundaries, not temporarily deferred implementation.
No roadmap slice may reintroduce them under a new name, compatibility wrapper,
generic interface, optional mode, or hidden fallback. Production code, tests,
and target documentation must no longer depend on:

- Task revisions, canonical hashes, seals, digests, historical comparison, or
  mutation detection;
- Plan-stage children, execution graphs, relations, multiple Work nodes, or continued
  role threads;
- accepted-revision delivery, delivery interfaces/records, convergence,
  finalizers, Git-commit identity as authority, or automatic merge;
- Root runtime registries, generations, family quarantine, restart routes, or
  cross-process session/workspace recovery;
- Codex app-server session protocol, dynamic tool bridge, or Root tool surface;
- generic Task Manager capability issuers, MCP schemas, or provider-neutral
  mutation records;
- Web surfaces, product-level local task mode, or any third operator control plane outside Podium Desktop;
- `spec_digest`, mutable `task_state`, artist route, or Critic-reference
  selection in the Cycle contract; task state remains Root-owned context;
- model access to the complete Root tree, descendant content, old role
  transcripts, or the Reconcile workspace;
- regex-heavy interpretation of free-form role status, a second model call to
  repair output format, or Performer-owned prompt construction;
- per-Cycle workspace creation, repository snapshots, patch stores, commit-hash
  authority, or Agent-owned commit/push/PR commands;
- Root claiming, workspace/run-directory allocation, or resource cleanup inside
  Conductor; those local lifecycle duties belong to Podium Desktop in V2;
- automatic retry, rollback, reset, cleanup, branch repair, PR adoption,
  unknown-outcome reconciliation, or silent Linear-to-local fallback;
- concurrent Cycles, multiple Roots per process, subagents, webhooks, child
  comments as instructions, partial Root-comment consumption, or custom Linear
  topology configuration;
- manual-edit detection for frozen child descriptions or full Agent trajectories
  uploaded to Linear.
- a standalone Trusted State service/ledger, a public Linear Projector service,
  an exactly-once PR claim, or local evidence stored inside the Root workspace.
- dynamic Agent plugin discovery/registry, per-Cycle routing, compatibility
  aliases, a shared error taxonomy, or public types for internal
  Inbox/workspace helpers.
- unbounded Harness feedback history or a background wait/retry loop.
- a one-shot Artist/Critic CLI or any public role-level Linear mutation path;
- semantic parsing, projection, or trust of Artist model output;
- required complete Agent trajectories or trajectory references in public
  contracts and Linear comments;
- raw Agent JSONL, stderr, or error context outside the caller-owned external
  run directory, or diagnostic content supplied to Critic, Root, or Linear;
- a second summarization or format-repair Agent call, or any Cycle Result that
  invents or semantically interprets role evidence; Cycle Result keeps only
  mechanical terminal fields and the typed Critique JSON file link/upload error.
- a Prepare Agent call, self-authored Critique file read-back, a second durable
  Desktop Root allocation, automatic priority preemption, or an Agent catalog
  for the single fixed `codex` adapter.

Only these direct replacements are allowed:

| Removed complexity | V1 replacement |
|---|---|
| revision, seal, digest, mutation comparison | none; immutable Root requirement plus managed snapshot and reviewed Root State |
| execution graph, Plan, multi-Work | one serial immutable Cycle with Artist then Critic |
| recovery, registry, generation, quarantine | cancel unfinished descendants, add Harness feedback, run fresh Reconcile |
| delivery subsystem and finalizer | one Root Reconcile Delivery decision; Conductor only validates and projects it |
| app-server, tool bridge, session resume | one fresh process from the run-selected thin Agent CLI adapter per role |
| generic Task Manager and capabilities | one injectable `LinearGateway` with the listed operations |
| Reconcile quality inference from workspace | reviewed task state, one pending finding, and Harness feedback |
| Trusted State subsystem | one task-state field and compact Critic checkpoint in `latest_critique` updated mechanically in Root State |
| PR exactly-once/recovery protocol | one ordered attempt; ambiguous restart becomes `NeedsHuman` |
| per-role Agent/model configuration | optional independent Reconcile, Artist, and Critic role configuration fixed for the Root run |

Any proposed exception changes the target architecture and requires explicit
user approval before code or tests are written.

Temporary local artifact names such as `round_001` and `rounds.jsonl` may remain
only as evidence-path compatibility. They are not target domain concepts.

## Black-box acceptance

| Scenario | Observable pass condition |
|---|---|
| minimal launch | the only public execution command accepts independent `--reconcile-*`, `--artist-*`, and `--critic-*` role values, one Root, an optional preferred workspace, and one supplied external run directory |
| visible status plane | startup binds or creates six exact Root statuses, descendants exclude `Needs Human`, name/type ambiguity fails closed, and every transition follows the Workflow Model matrix |
| exact topology | Linear shows `Root -> Cycle -> Artist + Critic`; at most one Cycle is active |
| visible snapshots | Root description has exactly one managed snapshot block refreshed with a presentation-only local `Updated at` line; Artist/Critic each receive exactly one terminal report append with the same local format |
| frozen input | a Root comment arriving during Artist/Critic appears only in the next Cycle |
| role isolation | Artist can write; Critic is a different fresh session and cannot write, with independent role capabilities/providers and no shared transcript |
| failed Artist | Critic still runs against the real residual workspace; Artist output is neither parsed nor supplied as evidence |
| private diagnostics | bounded raw Agent JSONL/stderr and causal error context remain only under the external run directory; refs/thread IDs never enter Critic, Root, or Linear |
| trust gate | only an `accepted` Critic adopts the Critic-supported task state and optional pending finding; Artist exit facts cannot pre-judge the result |
| Markdown/JSON result projection | role Markdown appends once; typed Critique JSON is serialized once and is the only Cycle upload; exactly two Cycle comments use Linear `createdAt`; Reconcile sees only compact `latest_critique` |
| comment transaction | failed family creation does not consume selected Root comments or start Artist |
| final delivery | Root Reconcile returns a PR, branch, or files Delivery; Conductor persists it, renders `## Delivery`, then sets Root Done |
| remote delivery failure | Root Reconcile may return local files; Conductor never retries or runs Git |

## V2 Podium Desktop

V1 remains a manually launched Conductor on one machine with one explicitly
supplied Root and run directory plus an optional preferred workspace. V2 adds Podium Desktop as a local
operator and scheduler surface above that unchanged CLI. Podium Desktop may
manage multiple local Conductors, but each Conductor still receives exactly one
Root, one workspace, and one external run directory.

Each persisted `ProjectBinding` contains:

- one Linear `project_id` and a visible `routing_label`;
- one `repository_path` and `base_branch`;
- one positive local `concurrency` limit; and
- one optional positive completed-workspace retention limit; and
- independent Reconcile, Artist, and Critic `RoleLaunchConfig` values.

For every assigned Root, Desktop derives stable preferred workspace and run
paths from its app-data root and Root ID. Root State becomes the sole durable
binding after Prepare; assignment, paths, process IDs, and the pending queue are
runtime state. Waiting Roots are ordered by Linear priority, creation time, and
ID but never automatically preempt running work. Explicit stop confirms the
complete Conductor process tree has exited.

Podium Desktop owns local routing, queueing, process supervision, and resource
lifecycle. It also owns the Linear authorization session for the one built-in
application, keeps tokens only in a private credentials file, and injects the current
access token into each Conductor environment. Codex remains fixed; private
per-role connection overrides are injected directly without an Agent catalog.
Conductor owns Root Reconcile, Cycle execution, Critic judgment, Root
State promotion, and terminal delivery. There is no cross-machine lease, SQLite
store, daemon IPC, or Web surface. `Needs Human` is a Root-only visible state.
Podium discovers an unprocessed direct reply in the active Human Action thread
and submits that Root to the unchanged ordinary queue. It adds no recovery
priority, label, answer UI, or Resume path.

## Verification layers

The reusable test surface has three named layers:

| Layer | Purpose | Default report |
|---|---|---|
| local | deterministic unit, contract, architecture, fake Linear, and temporary Git scenarios | one aggregate result with focused failures |
| boundary | independently diagnose Linear, Agent CLI, Git/push, and `gh` prerequisites | shown on failure or when explicitly requested |
| golden | create only a real Root Issue and prove the complete visible workflow and best available Delivery | the authoritative real end-to-end result |

Golden does not publish redundant blocked boundary records for capabilities it
has already exercised successfully. Fixtures own only the Linear/remote/temp
resources they create. Every run retains its Root Issue tree, workspace, run
directory, delivery PR, and branch for inspection. Cleanup is an explicit
manual action outside the E2E command; the fixture never archives, closes, or
deletes these resources automatically after success, failure, or timeout.

The scenario suite has six isolated cases. Each owns a distinct Root Issue,
workspace, run directory, assertions, and retained resources:

1. `single-cycle`
2. `multi-cycle`
3. `single-cycle-human-action`
4. `cycle-human-action-cycle`
5. `human-action-rejected-supplement`
6. `human-action-unanswered`

The deterministic layer and enabled Golden coverage run all six. When Golden
is disabled, the supervisor still enumerates every configured scenario and
reports each one as blocked. `npm run test:e2e` without `--scenario` starts all
configured scenarios concurrently with one direct `Promise.all`;
`--scenario <name>` starts only that scenario for debugging. Every behavior
change is accepted against the default all-scenario command.

Every scenario has its own five-minute timeout. The complete all-scenario run
has one six-minute timeout. A scenario creates its own Root Issue and may add
only the user comments required by that scenario. Those Issue and Comment
writes are the complete E2E input surface: the fixture must not invoke an
internal workflow operation, mutate internal state, or coordinate execution.
Assertions read the resulting Linear Issue tree and other user-visible
delivery boundaries as a black box. Each scenario result is reported when it
terminates, preserving the complete current error message and its private
`diagnostic_ref`; the final aggregate is reported after every selected
scenario terminates or the suite timeout fires.

The E2E supervisor must remain a bounded parallel launcher, not a scheduler.
The following are explicitly out of scope and must not be implemented in the
E2E harness:

- a queue, worker pool, concurrency limit, semaphore, or staged launch;
- priority, claim, preemption, fairness, or capacity-aware dispatch;
- retry, backoff, transient-error classification, or automatic rerun;
- per-phase or shared-budget timeout allocation beyond one timeout per
  scenario and one timeout for the complete run;
- direct Conductor, Root Reconcile, Cycle, Artist, or Critic scheduling;
- fixtures that advance workflow state through internal APIs, hidden state,
  or implementation-specific hooks instead of Root Issue creation and user
  comments;
- white-box acceptance based on internal call order, process structure, or
  private state rather than the externally visible result.

## Completion gates

| Gate | Required evidence |
|---|---|
| architecture | links and vocabulary checks pass; every target rule has one owner |
| subtraction | forbidden-system symbol/dependency search passes and every surviving abstraction maps to a v1 requirement |
| implementation | focused tests, Conductor tests, lint, typecheck, and build pass |
| real boundaries | Linear, Agent CLI, Git workspace, push, and PR tests prove actual permissions and ordering |
| end to end | fake Linear plus temporary Git remote proves Rejected repair Cycle, Succeeded Cycle, final Inbox check, and PR creation |
| diagnostics and failures | unknown failures retain causal local evidence, publish the complete current error message plus optional `diagnostic_ref`, and preserve the fixture resources unchanged |
| golden fixture retention | every Linear tree, workspace, run directory, PR, and branch remains available after the command exits |
| workspace lifecycle | completed Podium workspaces expose explicit cleanup; an optional retention limit removes only older completed workspaces |
| repository | full test suite, secret scan, scoped diff review, and human review pass |
