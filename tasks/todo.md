# Core Live E2E Tasks

## Task 1: Replace the authoritative E2E contract

**Description:** Rewrite the operational E2E specification around one core
live scenario. Remove claims that a hermetic Desktop composition is the product
E2E, state that OAuth and Desktop UI are excluded, and define the real
Podium/Conductor/Performer/Linear/Codex/Git evidence boundary.

**Acceptance criteria:**

- [x] `docs/testing/e2e.md` contains the repository scope record and the exact
      core live topology approved in `tasks/plan.md`.
- [x] Every Roadmap V1 item is marked `covered`, `partially covered`, or
      `deferred`; no fake or dry-run observation is called live evidence.
- [x] The document forbids E2E compositions, fake Linear clients, static
      Performer files, fake refresh tokens, and Linear credentials in Conductor.

**Verification:**

- [x] Check links and stale terminology with
      `rg -n "hermetic|e2e-main|TemporaryPodiumStore|fake Linear" docs README.md`.
- [x] Run `npm run test:architecture`.

**Dependencies:** None

**Files likely touched:**

- `docs/testing/e2e.md`
- `README.md`
- `tests/e2e/acceptance-v1.test.mjs`

**Estimated scope:** Medium

## Task 2: Define pipeline-only inputs and secret handling

**Description:** Replace the old OAuth/user-key configuration with one closed
environment contract for the core runner. The runner captures secrets once,
reports presence only, validates non-secret endpoint/model values, and creates
explicit child-process environment allowlists.

**Acceptance criteria:**

- [x] Required inputs are `SYMPHONY_E2E_LINEAR_DEV_TOKEN`,
      `SYMPHONY_E2E_CODEX_API_KEY`, `SYMPHONY_E2E_CODEX_BASE_URL`, and
      `SYMPHONY_E2E_CODEX_MODEL`; no `.env` file is required or loaded.
- [x] Base URL validation rejects non-HTTPS CI URLs, credentials, query,
      fragment, control characters, and hosts outside the configured allowlist.
- [x] Config summaries and errors expose only stable codes and secret-presence
      booleans; child environments omit both tokens by default.

**Verification:**

- [x] Run the focused config/runner tests under `tests/e2e/`.
- [x] Run `npm run test:e2e:runner` with an empty environment and verify it
      fails closed without printing supplied canaries.

**Dependencies:** Task 1

**Files likely touched:**

- `tools/e2e/config.mjs`
- `tools/e2e/doctor.mjs`
- `tests/e2e/runner.test.mjs`
- `tests/e2e/hermetic-config.test.mjs`

**Estimated scope:** Medium

## Task 3: Add a real Podium development-token installation

**Description:** Model a Linear Application development token as a first-class
Podium credential kind instead of fabricating OAuth refresh fields. Provide a
bounded bootstrap function used before the production Podium services start,
validate the token against Linear, discover its organization, and persist it in
the real SQLite Store.

**Acceptance criteria:**

- [x] Podium stores a discriminated OAuth or development-token installation;
      development-token records contain no refresh-token placeholder.
- [x] The bootstrap validates organization identity and token usability through
      the real `LinearSdkImpl`, then production client/conductor services read
      the same credential abstraction.
- [x] Refresh remains OAuth-only, and expired/invalid development tokens fail
      closed with sanitized errors.

**Verification:**

- [x] Run `npm test -w @symphony/podium`.
- [x] Run the relevant storage migration and Linear credential negative tests.
- [x] Confirm generated/public contracts contain no token or credential kind
      unless explicitly required by an existing Podium boundary.

**Dependencies:** Task 1

**Files likely touched:**

- `packages/podium/src/internal/models.ts`
- `packages/podium/src/internal/storage/SqlitePodiumStoreImpl.ts`
- `packages/podium/src/public/createPodiumConductorServices.ts`
- `packages/podium/src/public/bootstrapDevelopmentTokenInstallation.ts`
- `packages/podium/tests/storage.test.mjs`

**Estimated scope:** Medium

## Task 4: Pass the Codex endpoint through Performer process configuration

**Description:** Add one production-supported base URL input that Conductor
forwards unchanged to both Profile control and Turn Performer processes.
Performer validates it and constructs the pinned SDK with a public
`CodexConfig` override. Do not add a Profile field, provider map, environment
API key, or Codex file write.

**Acceptance criteria:**

- [x] Profile control and every Turn use the same validated
      `openai_base_url` override when configured and the SDK default when absent.
- [x] Performer rejects unsafe URLs before SDK startup and never logs the full
      configured URL if it contains unexpected sensitive material.
- [x] No Symphony code reads or writes `CODEX_HOME/config.toml` or `auth.json`.

**Verification:**

- [x] Run `.venv/bin/python -m pytest apps/performer/tests -q`.
- [x] Run `npm run typecheck -w @symphony/conductor` and its focused process
      tests.
- [x] Assert the SDK is built with public `CodexConfig` rather than private
      members or CLI/file manipulation.

**Dependencies:** Task 1

**Files likely touched:**

- `apps/performer/src/performer/__main__.py`
- `apps/performer/src/performer/backends/codex/codex_backend_impl.py`
- `apps/performer/tests/test_codex_backend.py`
- `apps/conductor/src/main.ts`
- `apps/conductor/src/performer-turns/tests/process.test.ts`

**Estimated scope:** Medium

## Checkpoint A: Production prerequisites

- [x] Tasks 1-4 focused tests pass.
- [x] No token appears in Conductor runtime configuration or generated
      contracts.
- [x] No E2E-only composition has been added.
- [x] Review the credential migration and base URL threat model before building
      the live harness.

## Task 5: Build the production core process harness

**Description:** Replace the Desktop-driven live driver with one runner-owned
transport harness. It bootstraps the real Podium Store/services, starts the
actual Conductor executable with inherited IPC, connects production protocol
handlers, observes the real handshake, and owns bounded shutdown. The harness
may adapt transport only; it must not implement Gateway or workflow behavior.

**Acceptance criteria:**

- [x] A test run reaches a real Conductor `ready`/`unbound` observation through
      generated framed contracts and production Podium handlers.
- [x] Linear token bytes are supplied only to Podium bootstrap and are absent
      from Conductor arguments, environment, frames, logs, and evidence.
- [x] Startup, protocol, process-exit, timeout, and shutdown failures are
      bounded and represented by sanitized stable codes.

**Verification:**

- [x] Run focused harness and inherited-protocol tests.
- [x] Run `npm run test:e2e:runner`.
- [x] Negative controls reject imports from `@symphony/podium/e2e`, fake
      `LinearClientInterface` implementations, and `e2e-main.ts`.

**Dependencies:** Tasks 2, 3, and 4

**Files likely touched:**

- `tools/e2e/core-live-runner.mjs`
- `tools/e2e/conductor-harness.mjs`
- `tools/e2e/step-runner.mjs`
- `tests/e2e/core-live-runner.test.mjs`
- `tests/e2e/production-negative-controls.test.mjs`

**Estimated scope:** Medium

## Task 6: Provision the real Performer Profile through Conductor

**Description:** Have the live runner send existing closed Profile commands to
Conductor: create one API Key Profile, deliver the pipeline token through the
bounded secret frame, observe SDK readiness, and activate the Profile. Profile
metadata is generated in memory and no Performer configuration file is used.

**Acceptance criteria:**

- [x] The Profile is created with `backendKind=codex`, `api_key`, configured
      model, bounded reasoning effort, and Fast disabled.
- [x] `set_api_key` reaches `Codex.login_api_key`, readiness becomes `ready`,
      and activation is reported by Conductor before any Root is created.
- [x] The API key appears only in the runner's secret buffer, bounded protocol
      frames, and Codex-owned state; buffers are cleared after use.

**Verification:**

- [x] Run Conductor Profile relay/control tests and Performer Profile control
      tests.
- [x] Run a canary-based scan over captured stdout/stderr, request/result
      files, Profile files, and runner evidence.

**Dependencies:** Task 5

**Files likely touched:**

- `tools/e2e/conductor-profile.mjs`
- `tools/e2e/conductor-harness.mjs`
- `tests/e2e/conductor-profile.test.mjs`
- `apps/conductor/src/performer-profiles/tests/control-process.test.ts`

**Estimated scope:** Medium

## Task 7: Create run-scoped Linear and Git fixtures

**Description:** Use the same development-token authority outside Symphony to
create one uniquely marked Linear Project and Root, and create one clean local
Git repository. Attach the Conductor Project Label required for real project
resolution. Cleanup archives only resources carrying the current managed run
marker and reconciles stale prior runs before mutation.

**Acceptance criteria:**

- [x] Every run starts with a unique Project, Root marker, app-data root,
      `CODEX_HOME`, repository, base branch, and evidence directory.
- [x] Preflight proves the token's organization/scopes and performs no mutation
      before the global/local lock is acquired.
- [x] Cleanup is idempotent, never uses fuzzy deletion, and can archive a stale
      interrupted run without touching unrelated Linear data.

**Verification:**

- [x] Run Linear operator, global lock, Git fixture, and cleanup contract tests.
- [x] Run dry-run/preflight with mutation counters and confirm zero mutations
      before lock acquisition.

**Dependencies:** Tasks 3 and 5

**Files likely touched:**

- `tools/e2e/linear-operator.mjs`
- `tools/e2e/git-fixture.mjs`
- `tools/e2e/global-lock.mjs`
- `tools/e2e/cleanup.mjs`
- `tests/e2e/cleanup.test.mjs`

**Estimated scope:** Medium

## Task 8: Complete one small real Root

**Description:** Compose the harness, Profile, and fixtures into the first
authoritative core live scenario. The Root asks Codex to create a file whose
content includes the exact run marker. The scenario waits for Plan, approves
the generated plan through Linear, lets separate Performer processes execute
Work and Root Gate, and verifies local branch delivery.

**Acceptance criteria:**

- [ ] A real Plan creates a bounded Linear issue tree and persists one opaque
      `performer_id` before Work begins.
- [ ] A real Work Turn changes the run-scoped repository, a later real Turn
      resumes the same `performer_id`, and Root Gate passes before delivery.
- [ ] The delivered branch contains the expected marker, Linear ends in Root
      `In Review` plus phase `in-review`, and Symphony does not mark the Root
      Done.

**Verification:**

- [x] Run the scenario in dry-run mode and assert its fixed state transitions.
- [ ] Run the credentialed local command once against the dedicated test
      workspace and configured Codex endpoint.
- [x] Evaluate sanitized evidence independently from runner exit status.

**Dependencies:** Tasks 6 and 7

**Files likely touched:**

- `tools/e2e/core-live-scenario.mjs`
- `tools/e2e/core-live-runner.mjs`
- `tools/e2e/verdict.mjs`
- `tests/e2e/core-live-scenario.test.mjs`
- `tests/e2e/acceptance-v1.test.mjs`

**Estimated scope:** Medium

## Checkpoint B: Local core live

- [ ] One local credentialed run completes successfully.
- [ ] Plan, Work, and Gate are separate real Performer processes.
- [ ] `performer_id`, Linear state, Git state, and Profile readiness converge.
- [ ] Cleanup succeeds when the scenario passes and when it is interrupted.
- [ ] No secret canary or private absolute path exists in evidence.

## Task 9: Remove the alternate credentialed/Desktop E2E runtime

**Description:** Before adding a core live command or workflow, remove the old
credentialed Desktop S1/S2/S3 runtime, static acceptance evidence pipeline,
Podium Desktop E2E backend, temporary Store, fake Linear composition, and the
package/build surfaces that make that route callable.

**Acceptance criteria:**

- [x] Production has one Podium backend entrypoint and one production service
      composition.
- [x] No package exports an E2E Podium composition, fake Linear client, or
      temporary credential Store.
- [x] No `acceptance:v1`, S1/S2/S3 runtime, Desktop E2E build branch, or static
      Roadmap verdict collector remains, and negative controls fail if one is
      reintroduced.

**Verification:**

- [x] Run Podium, Desktop backend, build, architecture, and focused E2E tests.
- [x] Run `rg -n "acceptance:v1|e2e-main|createE2EPodium|TemporaryPodiumStore|scenario-s[123]|s1-driver" apps packages tests tools package.json .github` and inspect every remaining reference.

**Dependencies:** Task 8

**Files likely touched:**

- `apps/podium-desktop/src-backend/e2e-main.ts`
- `packages/podium/src/e2e/index.ts`
- `packages/podium/src/e2e/createE2EPodiumServiceComposition.ts`
- `packages/podium/src/e2e/TemporaryPodiumStore.ts`
- `tools/e2e/acceptance-v1.mjs`
- `tests/acceptance/`

**Estimated scope:** Medium

## Task 10: Remove hermetic automation and preserve Desktop smoke

**Description:** Delete the hermetic WebdriverIO runner/config/tests and remove
its package/Makefile/workflow commands. Keep a clearly named, secret-free native
Desktop smoke that verifies only WebView/Tauri/sidecar startup and cannot be
reported as core workflow evidence.

**Acceptance criteria:**

- [x] No `e2e:hermetic`, hermetic WDIO configuration, hermetic artifact, or
      secret-free fake-Linear workflow claim remains.
- [x] Desktop smoke starts the production Desktop binary without live tokens
      and has a separate command, verdict, and artifact name.
- [x] The core live verdict and Desktop smoke verdict cannot satisfy each
      other's required evidence.

**Verification:**

- [x] Run Desktop smoke runner contract tests and `npm run test:e2e:runner`.
- [x] Run stale-reference searches across `package.json`, `Makefile`, workflows,
      README, docs, tests, and tools.

**Dependencies:** Task 9

**Files likely touched:**

- `tools/e2e/hermetic-desktop.mjs`
- `tests/e2e/hermetic-desktop.spec.mjs`
- `tests/e2e/hermetic-runner.test.mjs`
- `wdio.hermetic.conf.mjs`
- `apps/podium-desktop/tools/build-sidecars.mjs`

**Estimated scope:** Medium

## Checkpoint C: One E2E route

- [x] No alternate Podium composition, Desktop E2E backend, S1/S2/S3 runtime,
      hermetic runner, or hermetic workflow remains.
- [x] Desktop smoke is secret-free, starts production artifacts, and cannot
      satisfy the core live verdict.

## Task 11: Add local and protected CI entrypoints

**Description:** After all superseded workflow E2E routes are absent, expose
one stable local command and repurpose the manual Roadmap workflow to run that
same command in a protected GitHub Environment. Keep secret-free contract tests
on pull requests, serialize live runs, and always collect sanitized evidence
and cleanup.

**Acceptance criteria:**

- [x] `npm run e2e:core-live` is the only credentialed E2E entrypoint and uses
      the same runner locally and in CI.
- [x] GitHub Actions maps secrets only on preflight/run steps, uses a protected
      environment and `cancel-in-progress: false`, and never exposes them to a
      pull-request job.
- [x] Workflow artifacts are allowlisted, unique, bounded-retention, and fail
      when expected evidence is absent.

**Verification:**

- [x] Run `npm run test:e2e:runner` including workflow contract tests.
- [ ] Execute the protected GitHub Actions workflow once and record its run URL
      outside the repository artifact set.
- [x] Confirm cleanup runs under `if: always()` and remains idempotent.

**Dependencies:** Task 10

**Files likely touched:**

- `package.json`
- `Makefile`
- `.github/workflows/roadmap-v1-e2e.yml`
- `tests/e2e/ci-workflow.test.mjs`

**Estimated scope:** Medium

## Task 12: Verify and review the completed replacement

**Description:** Run focused checks first, then the repository-wide suite, one
local live run, and one protected CI live run. Review architecture ownership,
secret handling, failure semantics, test validity, and removal of the old path.
Do not mark this task complete from mocked runner tests alone.

**Acceptance criteria:**

- [ ] All focused and broad checks pass with no skipped live requirement.
- [ ] Local and CI evidence independently prove the same real small Root.
- [ ] A five-axis review finds no unresolved critical/high issue and documents
      remaining external-service/cost risk.

**Verification:**

- [ ] `make lint`
- [ ] `make typecheck`
- [ ] `make test-all`
- [ ] `make build`
- [ ] `npm run test:e2e:runner`
- [ ] `npm run e2e:core-live`
- [ ] `npm audit --registry=https://registry.npmjs.org`
- [ ] `.venv/bin/python -m pytest apps/performer/tests -q`
- [ ] `cd apps/podium-desktop/src-tauri && cargo test`

**Dependencies:** Task 11

**Files likely touched:**

- `tasks/todo.md`
- `docs/testing/e2e.md`
- Sanitized evidence under the documented ignored `.test/` path

**Estimated scope:** Small

## Checkpoint D: Complete

- [ ] Core live E2E is green locally and in the protected workflow.
- [ ] Desktop smoke is green and makes no live workflow claim.
- [ ] Old hermetic and E2E-composition paths are absent.
- [ ] Repository-wide checks and final review are complete.
