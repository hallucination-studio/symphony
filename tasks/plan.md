# Implementation Plan: Core Live E2E

## Outcome

Build one credentialed core E2E that runs locally and in a protected GitHub
Actions environment. The runner starts the real Podium control plane and the
real Conductor and Performer processes, uses real Linear and Codex endpoints,
and completes one small run-scoped Root against a fresh Git repository.

This is not a Desktop UI E2E and does not cover Linear OAuth. A separate,
secret-free native Desktop smoke remains responsible for the Desktop shell.

## Scope Record

### `authorized`

- Replace the current hermetic E2E direction with one core live runner.
- Supply all runtime inputs from the local shell or GitHub Environment; do not
  add a static Performer configuration file.
- Bootstrap a real Podium `DevelopmentTokenInstallation` from a Linear
  Application development token.
- Configure a real API Key Performer Profile through Conductor's existing
  closed profile-control protocol and bounded secret frame.
- Pass an allowlisted Codex base URL to Performer process configuration and use
  the pinned official Codex Python SDK for login, Turn start, and resume.
- Create a fresh Linear Project, app-data root, `CODEX_HOME`, and Git repository
  for every run, then execute Plan, Work, Root Gate, and branch delivery.
- Run the same core live command locally and in a protected, serialized GitHub
  Actions workflow.
- Retire the superseded E2E entrypoint, E2E Podium compositions, fake Linear
  client, temporary Store, and hermetic WebdriverIO automation after the live
  replacement passes.

### `required_consequences`

- Linear credential bytes remain Podium-owned and never enter Conductor.
- The Codex API key enters Conductor only as a bounded secret frame and is sent
  to Performer through the existing `set_api_key` path.
- The Codex base URL is non-secret process configuration; it is not a Profile
  field, arbitrary provider map, or Codex-owned file edit.
- The core live runner bypasses React/Tauri and must not claim Desktop coverage.
- CI live execution is unavailable to untrusted pull-request code.
- Empty state is created by run-scoped resources, not by revoking shared
  credentials.

### `out_of_scope`

- Linear OAuth, PKCE, callback, refresh, and revoke acceptance.
- ChatGPT login acceptance.
- Passing a Linear token to Conductor or a Codex token in process arguments,
  JSON metadata, request files, logs, screenshots, or artifacts.
- A static `performer.json`, direct writes to Codex `config.toml` or `auth.json`,
  or a generic Provider configuration tree.
- Secret-bearing Desktop UI E2E and automatic live execution for forked or
  otherwise untrusted pull requests.
- Remote GitHub pull-request delivery; the first live slice proves local branch
  delivery.
- S2/S3 recovery expansion, multi-Root scheduling, and fault injection until
  the small real Root is stable.

### `assumptions_requiring_approval`

None. The user approved the core live boundary, pipeline-provided credentials,
direct Conductor Profile configuration, and exclusion of OAuth/Desktop UI.

### `deferred_ideas`

- Conductor replacement and mutation-conflict live scenarios.
- Scheduled live runs after cost and cleanup history are understood.
- Remote branch push and pull-request delivery against a dedicated repository.
- A second Performer endpoint or generic Provider product configuration.

## Architecture Decisions

1. One runner owns orchestration, deadlines, evidence, and cleanup, but it does
   not implement Symphony business behavior.
2. Podium is initialized with a first-class development-token credential; no
   fake refresh token is stored.
3. The runner connects the actual Conductor process to production Podium
   services through generated framed contracts. No fake `LinearClientInterface`
   or alternate E2E composition is allowed.
4. Profile metadata is created in memory through Conductor. The Codex API key
   follows the existing secret relay and the SDK owns the resulting auth state
   under the run-scoped `CODEX_HOME`.
5. Performer maps the validated base URL to the pinned SDK's public
   `CodexConfig` override. Symphony never edits Codex-owned files.
6. A fresh Linear Project and local Git repository provide empty business state
   per run. Cleanup is idempotent and start-of-run reconciliation handles a
   previous interrupted run.

## Runtime Topology

```text
core-live runner
  |-- Linear dev token --> Podium DevelopmentTokenInstallation
  |                         `-> real LinearSdkImpl
  |-- generated IPC ------> real Conductor process
  |                           |-- create API Key Profile
  |-- Codex API key ----------|-- set_api_key secret frame
  |                           `-> real Performer process per Turn
  |                               `-> Codex SDK -> configured base URL
  |-- run-scoped Linear Project and Root
  `-- run-scoped Git repository <- Work Turn mutation and branch delivery
```

## Dependency Graph

```text
Task 1: authoritative test contract
  |-- Task 2: runner input and secret contract
  |-- Task 3: Podium development-token installation
  `-- Task 4: Performer endpoint configuration
          \        |        /
           Task 5: production process harness
                    |
           Task 6: direct Profile provisioning
                    |
           Task 7: run-scoped Linear/Git fixtures
                    |
           Task 8: small Root live scenario
                    |
           Task 9: local and GitHub Actions entrypoints
                    |
          Tasks 10-11: retire superseded paths
                    |
           Task 12: full verification and review
```

## Task Order

### Phase 1: Contract and production prerequisites

- [x] Task 1: Replace the E2E specification with the core live contract.
- [x] Task 2: Define the pipeline-only runner input and secret boundary.
- [x] Task 3: Add a real Podium development-token installation kind.
- [x] Task 4: Configure the Codex endpoint through Performer process input.

### Checkpoint: Production boundaries

- [x] Podium tests prove tokens do not cross into Conductor.
- [x] Performer tests prove base URL mapping without Codex file edits.
- [x] Runner contract tests prove secrets are absent from child environments,
      metadata, and evidence.

### Phase 2: Small real Root

- [ ] Task 5: Start real Podium services and a real Conductor process.
- [ ] Task 6: Provision and activate the real API Key Profile.
- [ ] Task 7: Create and reconcile run-scoped Linear and Git fixtures.
- [ ] Task 8: Complete one real Plan/Work/Gate/delivery scenario.

### Checkpoint: Local core live

- [ ] The same `performer_id` is observed across separate real Performer Turns.
- [ ] The expected run marker exists in the delivered branch.
- [ ] Linear ends in the documented In Review/in-review state.
- [ ] Sanitized evidence contains no known secret or absolute private path.

### Phase 3: Automation and retirement

- [ ] Task 9: Add the local command and protected GitHub Actions job.
- [ ] Task 10: Remove the alternate E2E runtime and Podium compositions.
- [ ] Task 11: Remove hermetic automation while preserving Desktop smoke.
- [ ] Task 12: Run broad verification and complete the final review.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Repository-controlled code exfiltrates CI secrets | Critical | Protected GitHub Environment, trusted refs only, explicit child-env allowlists |
| Configurable base URL redirects the Codex key | Critical | HTTPS-only validation, fixed host allowlist in CI, reject userinfo/query/fragment/redirects |
| Interrupted run leaves Linear data | Medium | Managed run marker, start reconciliation, idempotent archive cleanup, serialized CI |
| Development token is mistaken for OAuth coverage | Medium | Explicit post-token scope and separate OAuth exclusion in docs and verdicts |
| Runner reimplements Podium or Conductor behavior | High | Generated contracts plus production factories/processes; negative controls reject E2E compositions and fake SDK clients |
| Provider output varies | Medium | Tiny deterministic repository task, closed output schemas, state-based assertions rather than prose matching |
| Live cost or latency grows | Medium | One Root, bounded Turn count/deadlines, serialized workflow, no automatic retry storm |

## Completion Gate

- A credentialed local run and one GitHub Actions run both complete the same
  small Root using real Linear and Codex boundaries.
- Production Podium service factories, `SqlitePodiumStoreImpl`, Conductor
  `main.ts`, real Performer processes, `LinearSdkImpl`, and the pinned Codex SDK
  are used.
- No E2E entrypoint, E2E composition, fake Linear client, temporary Podium
  Store, or static Performer configuration file remains.
- Secret scans pass for source diffs, evidence, logs, request/result files, and
  uploaded artifacts.
- Focused checks, `make lint`, `make typecheck`, `make test-all`, and
  `make build` pass before review.
