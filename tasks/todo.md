# Real-time Root Managed Comment Tasks

## Working Rules

- One task equals one commit. Stage only the files listed for that task.
- The current staged/unstaged implementation is raw material, not a commit.
- Write the failing behavior test before changing production behavior.
- Run focused checks first and the task's broader checks before committing.
- Do not keep `turn-events.ndjson`, `--event-path`, a returned `events` array,
  or any other compatibility event route.
- Do not expose a Linear comment ID to Performer.
- Do not print tokens, credentials, raw Provider errors, or request bodies.

## Task 1: Persist Primary Status Turn observation fields

**Status:** Complete in commit `887fbba`.

**Description:** Extend the existing Primary Status Comment model so Conductor
can persist the latest correlated Turn ID, display status, event sequence, and
status timestamp without introducing a second state store.

**Acceptance criteria:**

- [x] All four fields are optional so existing managed comments remain valid.
- [x] `turn_event_sequence` accepts only a non-negative integer.
- [x] Parsing and serialization preserve the observation fields.

**Verification:**

- [x] `npx tsx --test --test-name-pattern='managed state parsers' apps/conductor/src/root-workflow/tests/domain.test.ts`
- [x] `npm run typecheck -w @symphony/conductor`

**Dependencies:** None

**Files:**

- `apps/conductor/src/root-workflow/api/Models.ts`
- `apps/conductor/src/root-workflow/internal/ManagedState.ts`
- `apps/conductor/src/root-workflow/tests/domain.test.ts`

**Estimated scope:** Small

**Commit:** `feat: persist Root Turn observation status`

## Task 2: Replace the architecture source of truth

**Status:** Complete.

**Description:** Rewrite the approved target architecture around one Primary
Status Comment, append-only Timeline Comments, and one live stdout event route.
Remove language that permits process-exit event replay or treats Timeline data
as workflow state.

**Acceptance criteria:**

- [x] Root architecture defines the Primary comment as the first
      Symphony-managed Root comment and records its Linear comment ID.
- [x] Performer Event architecture maps continuous events to ID-upsert and
      warning/error/completion to event-key append.
- [x] The glossary uses one unambiguous vocabulary and the docs explicitly
      exclude observation comments from revisions, hashes, stale checks, and
      scheduling.

**Verification:**

- [x] `npm run test:architecture`
- [x] `rg -n "event-path|turn-events|replay|last_error" docs/architecture`
- [x] Check all changed architecture links.

**Dependencies:** Task 1

**Files:**

- `docs/architecture/root-issue.md`
- `docs/architecture/performer-events.md`
- `docs/architecture/glossary.md`

**Estimated scope:** Medium

**Commit:** `docs: define Root status and Timeline comments`

## Task 3: Close the event and comment mutation contracts

**Description:** Define closed generated unions for Performer observations and
for the two Podium-Conductor Root comment mutation variants. The contract must
make `comment_id` and `event_key` mutually exclusive and support the maximum
legal Turn ID plus sequence suffix.

**Acceptance criteria:**

- [ ] Performer events include `error_raised` and `turn_completed` with only
      bounded, sanitized fields; comment identity is absent.
- [ ] Root comment mutation requires exactly one of `comment_id` or
      `event_key`; append keys accept every valid `turn_id:sequence`.
- [ ] TypeScript, Python, and Rust generated outputs match the schemas and
      invalid mixed/missing variants are rejected.

**Verification:**

- [ ] `npm run contracts:generate`
- [ ] `npm run contracts:check`
- [ ] `npm run test:contracts`
- [ ] `npm run contracts:validate:typescript`

**Dependencies:** Task 2

**Files:**

- `packages/contracts/schemas/conductor-performer/conductor-performer.schema.json`
- `packages/contracts/schemas/podium-conductor/podium-conductor.schema.json`
- `packages/contracts/generated/typescript/contracts.ts`
- `packages/contracts/generated/python/contracts.py`
- `packages/contracts/generated/rust/src/lib.rs`

**Estimated scope:** Medium; three files are generated outputs

**Commit:** `feat: define Root comment projection contracts`

## Checkpoint A: Contract

- [ ] Tasks 2-3 are committed separately and focused checks pass.
- [ ] No Performer contract contains Linear types, comment IDs, SDK objects, or
      arbitrary metadata.
- [ ] The human approves the event-to-comment mapping before runtime work.

## Task 4: Add a bounded Performer stdout event decoder

**Description:** Add the Conductor-owned streaming boundary that accepts stdout
chunks, frames newline-delimited JSON, validates the generated Event contract,
and checks Turn/Root/Work/sequence correlation before delivery.

**Acceptance criteria:**

- [ ] Frames split across chunks and multiple frames in one chunk decode in
      order without corrupting Unicode.
- [ ] Byte count, frame size, frame count, and incomplete terminal frames are
      bounded; malformed or uncorrelated frames become sanitized observation
      violations.
- [ ] `GlobalPerformerLane` drains stdout while the child runs and does not wait
      for process exit before invoking the decoder.

**Verification:**

- [ ] Run the focused event stream and Global Performer lane tests.
- [ ] `npm run typecheck -w @symphony/conductor`
- [ ] `npm run lint -w @symphony/conductor`

**Dependencies:** Task 3

**Files likely touched:**

- `apps/conductor/src/performer-turns/internal/GlobalPerformerLane.ts`
- `apps/conductor/src/performer-turns/internal/PerformerEventStreamDecoder.ts`
- `apps/conductor/src/performer-turns/tests/event-stream.test.ts`

**Estimated scope:** Medium

**Commit:** `feat: decode live Performer event frames`

## Task 5: Switch Performer Turns to the single live event route

**Description:** Make Turn-mode Performer stdout emit only flushed closed Event
frames and connect them to the decoder through `PerformerTurnProcessImpl`.
Remove the event file, event-path argument, post-exit collector, and returned
events array. Result publication remains atomic and authoritative.

**Acceptance criteria:**

- [ ] `turn_started` is observed before the fake child is released in a
      synchronization-barrier test.
- [ ] Same-Turn retries receive the next in-memory sequence start without an
      event file; a new Turn starts at zero.
- [ ] Successful Result publication precedes `turn_completed`; failed Results
      emit `error_raised`; process/result errors remain sanitized and bounded.

**Verification:**

- [ ] `npm test -w @symphony/conductor -- --test-name-pattern='Performer process'`
- [ ] `.venv/bin/python -m pytest apps/performer/tests/test_turn_host.py -q`
- [ ] `.venv/bin/python -m pytest apps/performer/tests -q`
- [ ] `rg -n "event-path|turn-events|events:" apps/conductor apps/performer`

**Dependencies:** Task 4

**Files likely touched:**

- `apps/conductor/src/performer-turns/internal/PerformerTurnProcessImpl.ts`
- `apps/conductor/src/performer-turns/tests/process.test.ts`
- `apps/performer/src/performer/__main__.py`
- `apps/performer/src/performer/turn_protocol/host.py`
- `apps/performer/tests/test_turn_host.py`

**Estimated scope:** Medium

**Commit:** `feat: stream Performer events during Turns`

## Task 6: Implement the two Linear SDK comment modes

**Description:** Implement Primary Status upsert and Timeline append in the
Podium-owned Linear SDK adapter. ID-upsert must use a targeted comment lookup;
append must use an exact hidden marker and bounded pagination for idempotent
read-back.

**Acceptance criteria:**

- [ ] ID-upsert rejects a missing comment, another Root's comment, a user
      comment, or a body with a different managed identity.
- [ ] Event-key append creates once, reports an exact matching body as already
      applied, and rejects an ambiguous or mismatched existing marker.
- [ ] More than 64 Root comments do not break Primary lookup, Timeline
      deduplication, or Root Primary discovery; all scans remain bounded.

**Verification:**

- [ ] `npm test -w @symphony/podium -- --test-name-pattern='Root comment'`
- [ ] Run SDK tests covering 65+ comments and ambiguous mutation read-back.
- [ ] `npm run typecheck -w @symphony/podium`

**Dependencies:** Task 3

**Files likely touched:**

- `packages/podium/src/internal/linear-gateway/types.ts`
- `packages/podium/src/internal/linear-gateway/internal/LinearSdkImpl.ts`
- `packages/podium/tests/linear-sdk.test.mjs`

**Estimated scope:** Medium

**Commit:** `feat: project Root comments through Linear SDK`

## Task 7: Expose comment projection through Podium-Conductor

**Description:** Map the generated exclusive union through Podium's production
Conductor services and retry protocol. Preserve exact idempotent outcome
read-back for ambiguous Linear responses without adding a generic metadata API.

**Acceptance criteria:**

- [ ] Podium maps the `comment_id` variant only to Primary upsert and the
      `event_key` variant only to Timeline append.
- [ ] Ambiguous append retries read back the exact event marker/body before
      returning `already_applied`.
- [ ] Project resolution remains the only project precondition; observation
      mutations require no Root or comment revision precondition.

**Verification:**

- [ ] `npm test -w @symphony/podium -- --test-name-pattern='Root event'`
- [ ] `npm test -w @symphony/podium`
- [ ] `npm run typecheck -w @symphony/podium`

**Dependencies:** Tasks 3 and 6

**Files likely touched:**

- `packages/podium/src/internal/composition/PodiumConductorServicesImpl.ts`
- `packages/podium/src/internal/linear-gateway/LinearGatewayProtocolHandlerImpl.ts`
- `packages/podium/tests/linear-gateway.test.mjs`

**Estimated scope:** Medium

**Commit:** `feat: expose Root comment projection to Conductor`

## Checkpoint B: Production boundaries

- [ ] Tasks 4-7 are committed separately and all focused checks pass.
- [ ] No event file or batch replay route remains.
- [ ] A Primary update cannot overwrite a user comment.
- [ ] Timeline idempotency remains correct above 64 comments.

## Task 8: Project live status to the Primary comment ID

**Description:** Subscribe before each Performer process starts and serialize
continuous observations onto the saved Primary Status Comment ID. Merge the
latest successful status projection in memory so final usage/recovery updates
cannot overwrite it with the pre-Turn snapshot.

**Acceptance criteria:**

- [ ] Start/progress/usage/heartbeat events update the same `comment_id` while
      the Performer process is still running.
- [ ] No status write carries a comment revision or forces a Root snapshot
      refresh; Root comment `updatedAt` changes alone do not stale the Result.
- [ ] Root input, state, phase, tree, ownership, profile, and Work input changes
      still reject stale Results.

**Verification:**

- [ ] Run the synchronization-barrier status projection test.
- [ ] Run stale Root/Work Result regression tests.
- [ ] `npm test -w @symphony/conductor`
- [ ] `npm run typecheck -w @symphony/conductor`

**Dependencies:** Tasks 5 and 7

**Files likely touched:**

- `apps/conductor/src/composition/ManagedRootActionExecutor.ts`
- `apps/conductor/src/composition/ManagedRootActionExecutor.test.ts`

**Estimated scope:** Medium

**Commit:** `feat: update live Root Turn status by comment ID`

## Task 9: Append Timeline events and isolate observation failures

**Description:** Map warning, error, and Turn completion events to append-only
Timeline Comments. Make logging and Linear projection best-effort observations
that never replace or invalidate the closed Result path.

**Acceptance criteria:**

- [ ] Each Timeline body contains a user-readable sanitized summary and exact
      hidden `turn_id:sequence` marker; duplicate consumption appends once.
- [ ] `error_raised` and `turn_completed` never overwrite Primary status or
      `last_error`; completion text says Performer Turn, not Root completion.
- [ ] Projection/logging failure emits one structured correlated warning and
      does not change a valid Result, retry decision, or workflow mutation.

**Verification:**

- [ ] Run error, completion, retry, duplicate, and projection-failure tests.
- [ ] Spot-check structured logs for Turn, Root, optional Work, sequence, kind,
      code, retryability, and sanitized reason.
- [ ] `npm test -w @symphony/conductor`
- [ ] `make lint`

**Dependencies:** Task 8

**Files likely touched:**

- `apps/conductor/src/composition/ManagedRootActionExecutor.ts`
- `apps/conductor/src/composition/ManagedRootActionExecutor.test.ts`
- `apps/conductor/src/main.ts`

**Estimated scope:** Medium

**Commit:** `feat: append Root Turn Timeline events`

## Checkpoint C: Runtime behavior

- [ ] Tasks 8-9 are committed separately and Conductor tests pass.
- [ ] A failed Performer process can still expose already emitted error events.
- [ ] Observation failures cannot become workflow failures.
- [ ] Secret scans find no credential or raw Provider payload in comments or
      logs.

## Task 10: Add real Linear comment evidence to core-live E2E

**Description:** Extend the existing live verdict with a final real Linear read
that proves one Primary managed comment remains and successful Turns append
deduplicated completion Timeline Comments. Do not add an E2E-specific mutation
or fake event route.

**Acceptance criteria:**

- [ ] Live evidence finds exactly one Root Primary marker and no duplicate
      Primary comments after multiple Turns.
- [ ] Every observed completion Timeline marker has a unique
      `turn_id:sequence` key and a bounded sanitized body.
- [ ] Evidence records only counts, public identifiers, event kinds, and
      stable keys; no comment bodies containing user/provider content are
      uploaded.

**Verification:**

- [ ] `npm run test:e2e:runner`
- [ ] Run focused Linear operator and verdict tests.
- [ ] `npm run e2e:core-live` against real Linear/Codex and retain the sanitized
      result path.

**Dependencies:** Task 9

**Files likely touched:**

- `tools/e2e/linear-operator.mjs`
- `tools/e2e/core-live-runner.mjs`
- `tools/e2e/core-live-verdict.mjs`
- `tests/e2e/linear-operator.test.mjs`
- `tests/e2e/core-live-verdict.test.mjs`

**Estimated scope:** Medium

**Commit:** `test: verify Root comments in core live E2E`

## Task 11: Complete verification and create the PR

**Description:** Review the complete diff, run the repository-wide gates, then
run the real local E2E before pushing. Create the PR only after local success
and observe the protected GitHub Actions workflow to a terminal result.

**Acceptance criteria:**

- [ ] No old event transport, duplicate comment model, dead helper, unstaged
      generated output, or secret appears in the final diff.
- [ ] All repository checks and local core-live E2E pass from the committed
      branch.
- [ ] The PR is created with exact verification evidence and the protected live
      workflow reaches a terminal result; follow-up fixes remain one task per
      commit.

**Verification:**

- [ ] `npm run contracts:check`
- [ ] `make lint`
- [ ] `make typecheck`
- [ ] `make test-all`
- [ ] `make build`
- [ ] `git diff --check`
- [ ] `npm run e2e:core-live`
- [ ] Review GitHub Actions logs and sanitized artifacts without exposing
      secrets.

**Dependencies:** Task 10

**Files likely touched:** None unless verification finds a scoped defect

**Estimated scope:** Medium operational task

**Commit:** None unless a verified defect requires its own fix commit

## Completion Checklist

- [ ] Every task satisfies its acceptance criteria and the repository
      Definition of Done.
- [ ] Tasks 2-10 each map to one atomic commit.
- [ ] One live event path and two Root comment modes are the only supported
      implementation.
- [ ] Local and GitHub Actions core-live runs both pass.
