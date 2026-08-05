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
| 2 | minimal contracts | introduce only Root snapshot/state, CycleSpec, Execute process facts, Audit result, mechanical Cycle summary, Performer launch, Gateway, Root workspace, and PR result values | focused contract tests |
| 3 | Linear boundary and CLI | injectable Gateway, GraphQL adapter, and one Root-run command | fake Gateway and built CLI scenarios |
| 4 | supplied Root resources | validate and bind one caller-supplied workspace and external run directory | real Git and filesystem boundary scenario |
| 5 | Root Reconcile and Cycle projection | one frozen small-step contract and exact Root/Cycle/Execute/Audit hierarchy | semantic and fake Linear tests |
| 6 | Execute and Audit | fresh workspace-write Execute with no semantic output, then distinct fresh read-only Audit as sole semantic authority, including failed Execute inspection | real Agent CLI boundary tests |
| 7 | Root State and Inbox | promote only `accepted` Audits; checkpoint supplied paths, task state, pending finding, and comment cursor | focused transaction scenarios |
| 8 | terminal PR function | final Inbox check, one commit, one push, one PR, then Root Done; no subsystem or recovery logic | temporary remote and fake PR CLI scenario |
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
- Dashboard, product-level local task mode, or any second operator control plane;
- `spec_digest`, mutable `task_state`, executor route, or Audit-reference
  selection in the Cycle contract; task state remains Root-owned context;
- model access to the complete Root tree, descendant content, old role
  transcripts, or the Reconcile workspace;
- regex-heavy interpretation of free-form role status, a second model call to
  repair output format, or Performer-owned prompt construction;
- per-Cycle workspace creation, repository snapshots, patch stores, commit-hash
  authority, or Agent-owned commit/push/PR commands;
- Root claiming, workspace/run-directory allocation, or resource cleanup inside
  Conductor;
- automatic retry, rollback, reset, cleanup, branch repair, PR adoption,
  unknown-outcome reconciliation, or silent Linear-to-local fallback;
- concurrent Cycles, multiple Roots per process, subagents, webhooks, child
  comments as instructions, partial Root-comment consumption, or custom Linear
  topology configuration;
- manual-edit detection for frozen child descriptions or full Agent trajectories
  uploaded to Linear.
- a standalone Trusted State service/ledger, a public Linear Projector service,
  an exactly-once PR claim, or local evidence stored inside the Root workspace.
- dynamic Agent plugin discovery/registry, per-role Agent or model selection,
  legacy round aliases, a shared error taxonomy, or public types for internal
  Inbox/workspace helpers.
- unbounded Harness feedback history or a background wait/retry loop.
- a one-shot Execute/Audit CLI or any public role-level Linear mutation path;
- semantic parsing, projection, or trust of Execute model output;
- required complete Agent trajectories or trajectory references in public
  contracts and Linear comments;
- a Cycle Result that copies Audit evidence or acts as a second judgment; the
  surviving Cycle Result is only a mechanical operator summary.

Only these direct replacements are allowed:

| Removed complexity | V1 replacement |
|---|---|
| revision, seal, digest, mutation comparison | none; Root description plus audited Root State |
| execution graph, Plan, multi-Work | one serial immutable Cycle with Execute then Audit |
| recovery, registry, generation, quarantine | cancel unfinished descendants, add Harness feedback, run fresh Reconcile |
| delivery subsystem and finalizer | one fixed Conductor commit/push/create-PR function |
| app-server, tool bridge, session resume | one fresh process from the run-selected thin Agent CLI adapter per role |
| generic Task Manager and capabilities | one injectable `LinearGateway` with the listed operations |
| Reconcile workspace inspection | audited task state, one pending finding, and Harness feedback |
| Trusted State subsystem | one task-state field and one pending finding updated mechanically in Root State |
| PR exactly-once/recovery protocol | one ordered attempt; ambiguous restart becomes `NeedsHuman` |
| per-role Agent/model configuration | one required `--agent` and one model/reasoning configuration for the complete Root run |

Any proposed exception changes the target architecture and requires explicit
user approval before code or tests are written.

Temporary local artifact names such as `round_001` and `rounds.jsonl` may remain
only as evidence-path compatibility. They are not target domain concepts.

## Black-box acceptance

| Scenario | Observable pass condition |
|---|---|
| minimal launch | the only public execution command requires `--agent codex`, one Root, one supplied workspace, and one supplied external run directory |
| exact topology | Linear shows `Root -> Cycle -> Execute + Audit`; at most one Cycle is active |
| frozen input | a Root comment arriving during Execute/Audit appears only in the next Cycle |
| role isolation | Execute can write; Audit is a different fresh session and cannot write |
| failed Execute | Audit still runs against the real residual workspace; Execute output is neither parsed nor supplied as evidence |
| trust gate | only an `accepted` Audit adopts the Auditor-supported task state and optional pending finding; Execute exit facts cannot pre-judge the result |
| comment transaction | failed family creation does not consume selected Root comments or start Execute |
| final delivery | completion with no new Root input creates one commit, pushes one branch, creates one PR, records its URL, then sets Root Done |
| PR failure | any commit/push/PR error leaves Root open and workspace intact; no automatic retry or recovery runs |

## V2 Podium

V1 stops at a manually launched Conductor on one machine with one explicitly
supplied Root, workspace, and run directory. It does not contain a scheduler.

V2 introduces Podium above Conductor with this fixed ownership boundary:

| Owner | Responsibility | Must not own |
|---|---|---|
| Podium | claim eligible Root Issues, allocate workspace/run-directory pairs, launch and observe one bound Conductor, and own resource lifecycle | Cycle semantics, role prompts, Audit judgment, Root State promotion, or PR publication |
| Conductor | execute one already-bound Root or one selected Cycle role using supplied paths | Root discovery/claiming, workspace selection, directory allocation, or fleet scheduling |

Podium has Client and Web surfaces that share the same application boundary.
V2 first verifies and integrates the existing Client surface, whose
implementation is outside this repository, then adds the Web surface. V1 does
not add placeholder APIs, storage, daemon state, or Web code. Before production
implementation, V2 must define claim leases, multi-process ownership, resource
retention, authentication, and recovery.

## Completion gates

| Gate | Required evidence |
|---|---|
| architecture | links and vocabulary checks pass; every target rule has one owner |
| subtraction | forbidden-system symbol/dependency search passes and every surviving abstraction maps to a v1 requirement |
| implementation | focused tests, Conductor tests, lint, typecheck, and build pass |
| real boundaries | Linear, Agent CLI, Git workspace, push, and PR tests prove actual permissions and ordering |
| end to end | fake Linear plus temporary Git remote proves Rejected repair Cycle, Succeeded Cycle, final Inbox check, and PR creation |
| repository | full test suite, secret scan, scoped diff review, and human review pass |
