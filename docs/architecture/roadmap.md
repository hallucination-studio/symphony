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
| 2 | minimal contracts | Root state/`latest_audit`, managed snapshot, terminal role descriptions, Cycle history, typed Audit JSON, Performer, Gateway, workspace, and PR values | focused contract tests |
| 3 | Linear boundary and CLI | injectable Gateway, GraphQL adapter, and one Root-run command | fake Gateway and built CLI scenarios |
| 4 | supplied Root resources | validate and bind one caller-supplied workspace and external run directory | real Git and filesystem boundary scenario |
| 5 | Root Reconcile and Cycle projection | frozen small-step contract, managed snapshot, terminal role reports, Cycle history, typed Audit JSON, and Root/Cycle/Execute/Audit hierarchy | semantic and fake Linear tests |
| 6 | Execute and Audit | fresh workspace-write Execute and distinct fresh read-only Audit each deliver one final Markdown file; Audit remains sole semantic authority, including failed Execute inspection | real Agent CLI boundary tests |
| 7 | Root State and Inbox | save every complete terminal Audit as `latest_audit`; promote only `accepted` Audits; checkpoint supplied paths, task state, pending finding, and comment cursor | focused transaction scenarios |
| 8 | terminal delivery function | final Inbox check, one commit, one push, one `gh` PR attempt; PR unavailable records the pushed branch, then Root Done | temporary remote and fake PR CLI scenario |
| 9 | scenario suite and docs | rebuild tests around reusable business scenarios and prove the complete manual single-machine flow | black-box suite |

Root comment injection starts only after frozen Cycle projection and role
isolation pass. The PR function starts only after Root completion and trusted
Root State gates pass.

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
- `spec_digest`, mutable `task_state`, executor route, or Audit-reference
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
- a one-shot Execute/Audit CLI or any public role-level Linear mutation path;
- semantic parsing, projection, or trust of Execute model output;
- required complete Agent trajectories or trajectory references in public
  contracts and Linear comments;
- raw Agent JSONL, stderr, or error context outside the caller-owned external
  run directory, or diagnostic content supplied to Audit, Root, or Linear;
- a second summarization or format-repair Agent call, or any Cycle Result that
  invents or semantically interprets role evidence; Cycle Result keeps only
  mechanical terminal fields and the typed Audit JSON file link/upload error.

Only these direct replacements are allowed:

| Removed complexity | V1 replacement |
|---|---|
| revision, seal, digest, mutation comparison | none; immutable Root requirement plus managed snapshot and audited Root State |
| execution graph, Plan, multi-Work | one serial immutable Cycle with Execute then Audit |
| recovery, registry, generation, quarantine | cancel unfinished descendants, add Harness feedback, run fresh Reconcile |
| delivery subsystem and finalizer | one fixed Conductor commit/push/create-PR function |
| app-server, tool bridge, session resume | one fresh process from the run-selected thin Agent CLI adapter per role |
| generic Task Manager and capabilities | one injectable `LinearGateway` with the listed operations |
| Reconcile workspace inspection | audited task state, one pending finding, and Harness feedback |
| Trusted State subsystem | one task-state field, one pending finding, and parsed Audit fields in `latest_audit` updated mechanically in Root State |
| PR exactly-once/recovery protocol | one ordered attempt; ambiguous restart becomes `NeedsHuman` |
| per-role Agent/model configuration | optional independent Reconcile, Execute, and Audit role configuration fixed for the Root run |

Any proposed exception changes the target architecture and requires explicit
user approval before code or tests are written.

Temporary local artifact names such as `round_001` and `rounds.jsonl` may remain
only as evidence-path compatibility. They are not target domain concepts.

## Black-box acceptance

| Scenario | Observable pass condition |
|---|---|
| minimal launch | the only public execution command accepts independent `--reconcile-*`, `--execute-*`, and `--audit-*` role values, one Root, one supplied workspace, and one supplied external run directory |
| visible status plane | startup binds or creates the five exact canonical statuses, rejects name/type ambiguity, leaves other user states untouched, and every Root/Cycle/Execute/Audit transition follows the Workflow Model matrix |
| exact topology | Linear shows `Root -> Cycle -> Execute + Audit`; at most one Cycle is active |
| visible snapshots | Root description has exactly one managed snapshot block refreshed with a local RFC3339 `Updated at` line; Execute/Audit each receive exactly one terminal report append with one local RFC3339 `Updated at` line |
| frozen input | a Root comment arriving during Execute/Audit appears only in the next Cycle |
| role isolation | Execute can write; Audit is a different fresh session and cannot write, with independent role capabilities/providers and no shared transcript |
| failed Execute | Audit still runs against the real residual workspace; Execute output is neither parsed nor supplied as evidence |
| private diagnostics | bounded raw Agent JSONL/stderr and causal error context remain only under the external run directory; refs/thread IDs never enter Audit, Root, or Linear |
| trust gate | only an `accepted` Audit adopts the Auditor-supported task state and optional pending finding; Execute exit facts cannot pre-judge the result |
| Markdown/JSON result projection | role Markdown appends once; typed Audit JSON is the only Cycle upload; history uses Linear `createdAt`; Reconcile sees only parsed `latest_audit` |
| comment transaction | failed family creation does not consume selected Root comments or start Execute |
| final delivery | completion with no new Root input creates one commit, pushes one branch, prefers a `gh` PR, records its URL or the pushed branch, then sets Root Done |
| PR failure | any commit/push/PR error leaves Root open and workspace intact; no automatic retry or recovery runs |

## V2 Podium Desktop

V1 remains a manually launched Conductor on one machine with one explicitly
supplied Root, workspace, and run directory. V2 adds Podium Desktop as a local
operator and scheduler surface above that unchanged CLI. Podium Desktop may
manage multiple local Conductors, but each Conductor still receives exactly one
Root, one workspace, and one external run directory.

Each persisted `ProjectBinding` contains:

- one Linear `project_id` and a visible `routing_label`;
- one `repository_path` and `base_branch`;
- one positive local `concurrency` limit; and
- independent Reconcile, Execute, and Audit `RoleLaunchConfig` values.

For every assigned Root, Desktop persists stable `root_id`, `workspace_path`,
and `run_directory` paths. Assignment records, process IDs, and the pending
queue are in-memory runtime state only. A higher-priority assignment may
preempt a lower-priority local assignment; equal priority never preempts. The
stop sequence confirms that the complete Conductor process tree has exited
before a replacement starts.

Podium Desktop owns local routing, queueing, process supervision, and resource
lifecycle. Conductor owns Root Reconcile, Cycle execution, Audit judgment, Root
State promotion, and terminal delivery. There is no cross-machine lease, SQLite
store, daemon IPC, or Web surface. This round does not add Podium scheduling,
UI, or E2E behavior for Conductor `NeedsHuman`; the existing V1 terminal state
and workflow remain unchanged.

## Completion gates

| Gate | Required evidence |
|---|---|
| architecture | links and vocabulary checks pass; every target rule has one owner |
| subtraction | forbidden-system symbol/dependency search passes and every surviving abstraction maps to a v1 requirement |
| implementation | focused tests, Conductor tests, lint, typecheck, and build pass |
| real boundaries | Linear, Agent CLI, Git workspace, push, and PR tests prove actual permissions and ordering |
| end to end | fake Linear plus temporary Git remote proves Rejected repair Cycle, Succeeded Cycle, final Inbox check, and PR creation |
| diagnostics and failures | unknown failures retain causal local evidence, publish the current message's first 50 characters plus optional `diagnostic_ref`, and golden failure cleanup archives evidence first |
| repository | full test suite, secret scan, scoped diff review, and human review pass |
