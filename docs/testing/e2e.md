# E2E Testing

The target test suite is rebuilt from business scenarios. Existing tests that
encode revision, Plan/DAG, Work/Verify, app-server, capability, delivery, or
runtime-registry fields are deleted with those systems; they are not translated
field by field into the new architecture.

## Test contract

Every scenario declares four things:

```text
given: public Linear, workspace, run-directory, and provider state
when: one CLI action (`run` or `cycle`)
then: public Linear, workspace, process, and PR outcomes
cleanup: resources owned by that scenario
```

Assertions target observable outcomes, not private classes, method calls,
serialized implementation fields, log ordering, or intermediate parser shapes.
A scenario may contain several coherent assertions when together they prove one
business result.

## Shared scenario kit

Reuse setup and boundary mechanics, not expected business behavior:

| Shared part | Responsibility |
|---|---|
| `ScenarioWorld` | create one Root, isolated workspace, external run directory, temporary remote, and deterministic clock/IDs |
| `LinearDriver` | fake or real provider setup and public observation |
| `AgentDriver` | scripted or real CLI role outcomes behind the production Performer contract |
| `ProcessDriver` | launch the built `run` or `cycle` command and capture sanitized termination |
| `EvidenceReader` | read public Issue/comments/status, workspace diff, PR result, and bounded run evidence |
| `ScenarioCleanup` | remove only resources explicitly owned by the scenario and report every cleanup failure |

Scenario files remain readable end to end. They may use the shared world and
drivers, but each keeps its own given/when/then values and outcome assertions.
Do not introduce a generic assertion DSL, snapshot the entire Root tree, or
hide business expectations in fixtures.

## Layers

| Layer | Boundary | Purpose |
|---|---|---|
| contract | pure values and parsers | closed CLI, CycleSpec, Root State, and role-result variants only |
| scenario | fake Linear/Agent plus real filesystem/Git | complete Root and one-shot role behavior with fast deterministic feedback |
| boundary | one real Linear, Agent CLI, Git, GitHub, or permission edge | prove each external integration with the smallest scenario |
| golden | built process with real boundaries | one manual single-machine Root reaches one PR and `Done` |

Focused production debugging uses the same built entry:

```bash
lh-harness cycle \
  --issue ENG-128 \
  --workspace /absolute/root-workspace \
  --dir /absolute/root-run-directory \
  --agent codex \
  --model gpt-5.6-luna \
  --reasoning-effort max
```

This command is itself scenario-covered: it runs only the selected existing
Execute or eligible Audit, writes only that role result/status, starts no poll,
does not close the Cycle or promote Root State, and never publishes a PR.

## Required scenarios

| Scenario | Observable result |
|---|---|
| manual launch | one Root binds to the supplied workspace/run directory and uses Root title/description as its only requirement |
| exact topology | Linear shows `Root -> Cycle -> Execute + Audit`, with at most one active Cycle |
| frozen input | a Root comment arriving during Execute/Audit enters only the next Cycle |
| successful Cycle | completed Execute plus `accepted` Audit adopts its task state and optional pending finding |
| rejected Cycle | `incomplete` Audit records one pending finding and the next Reconcile creates a repair Cycle |
| failed Execute | Execute error is recorded and a fresh read-only Audit still inspects residual workspace state |
| integrity failure | `violation` fails the Cycle and never promotes task state |
| process failure | `process_error` fails closed with sanitized evidence |
| family transaction | partial family creation consumes no Root comments and starts no Agent |
| restart abandonment | unfinished descendants are canceled and the supplied paths are reused exactly |
| one-shot Execute | `cycle` runs one Execute and exits without dispatching Audit |
| one-shot Audit | `cycle` rejects active, terminal, or otherwise ineligible input and runs an eligible waiting Audit without closing its Cycle |
| final Inbox fence | new Root input cancels completion and returns to Reconcile |
| final publication | empty Inbox produces one commit, push, PR URL, then Root `Done` |
| publication failure | failed commit/push/PR leaves Root open and workspace/run evidence intact without retry |

Add a focused unit case only when a parser or deterministic transition has an
independent contract that these scenarios cannot diagnose precisely. Do not
recreate one test per field, branch, error code, Markdown line, or private
helper.

## Execution

The repository-owned supervisor starts the built Conductor, partitions fixture
and product credentials, enforces one wall-clock deadline, waits for every
started child, and performs ownership-aware cleanup. It contains no workflow
logic or expected business values.

The deterministic scenario suite runs before real-boundary and golden tests.
Independent scenarios may run concurrently with isolated Roots, workspaces, and
run directories. One failure does not cancel peers; the final report lists all
violations, blocked observations, retained resources, and cleanup failures.

Never place tokens, cookies, API keys, prompts, raw model streams, or file
contents in scenario names, fixtures, diagnostics, or final reports.
