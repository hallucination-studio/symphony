# Implementation Plan: Real-time Root Managed Comments

## Outcome

Implement one production event path from Performer to Conductor and project
closed Turn observations into two user-visible Root comment modes:

1. One Primary Status Comment is created when Symphony claims the Root. Its
   Linear `comment_id` is retained in `RootRunView` and every continuous status
   observation updates that exact comment by ID.
2. Discrete warning, error, and Turn completion observations append immutable
   Timeline Comments. Each append is idempotent by `turn_id:sequence`.

The event path must be live while the Performer process is running. It must not
retain the existing process-exit batch replay as a second route. Comment
projection is observational and cannot change Performer Result acceptance,
Workflow scheduling, or stale-result decisions.

## Scope Record

### `authorized`

- Replace the current event-file collection and post-exit batch projection
  with one bounded stdout NDJSON event channel.
- Keep the Performer Event body as a closed, generated contract.
- Persist the latest Turn observation in the existing Primary Status Comment.
- Append warning, `error_raised`, and `turn_completed` Timeline Comments.
- Add a closed Podium-Conductor mutation with mutually exclusive ID-upsert and
  event-key-append variants.
- Make Timeline append idempotent by `turn_id:sequence`.
- Remove Root/comment revision preconditions from observation-only writes and
  exclude those writes from workflow hashes and stale Result checks.
- Add local unit, integration, and core-live evidence for the final behavior.

### `required_consequences`

- Performer never receives a Linear comment ID and never writes Linear.
- Podium remains the only role that owns the Linear SDK and validates comment
  identity and Root ownership.
- The Primary Status Comment remains the only Root comment parsed as recovery
  state. Timeline Comments never enter `RootRunView` workflow facts.
- Event projection failures produce correlated structured logs but do not
  change the closed Performer Result or Root scheduling outcome.
- Same-Turn retries continue the event sequence in Conductor memory; events are
  not persisted or replayed as a workflow ledger.
- Existing uncommitted event work is repartitioned by task. It is not committed
  wholesale and does not create a compatibility route.

### `out_of_scope`

- Provider 502 diagnosis, model/request-shape changes, or endpoint retries.
- Linear OAuth acceptance or Desktop UI E2E.
- A workflow database, event database, durable queue, or replay log.
- Provider reasoning, tool payloads, stdout logs, raw exceptions, or arbitrary
  metadata in the Performer Event contract.
- A second event transport retained for compatibility.
- A live fault-injection scenario that intentionally consumes Provider quota.

### `assumptions_requiring_approval`

None. The user approved one live status comment, append-only error/completion
events, ID-based upsert, append-by-default behavior, and
`turn_id:sequence` idempotency.

### `deferred_ideas`

- Desktop rendering of the Timeline as a dedicated view.
- Metrics and alerting derived from Performer Event outcomes.
- Live Provider fault injection after the happy-path core E2E is stable.

## Current Baseline

- Commit `887fbba` already persists optional Turn observation fields in the
  Primary Status Comment parser and serializer.
- The remaining staged and unstaged files are not a valid commit boundary. They
  contain both the superseded event-file batch route and an unfinished stdout
  route.
- Before each implementation task, stage only that task's files. Do not commit
  the current index as one change.

## Architecture Decisions

### Comment modes

| Observation | Root comment behavior | Identity |
|---|---|---|
| `turn_started` | upsert Primary Status | saved `comment_id` |
| `progress` | upsert Primary Status | saved `comment_id` |
| `usage_updated` | upsert Primary Status observation only | saved `comment_id` |
| `heartbeat` | upsert Primary Status | saved `comment_id` |
| `warning_raised` | append Timeline | `turn_id:sequence` |
| `error_raised` | append Timeline | `turn_id:sequence` |
| `turn_completed` | append Timeline | `turn_id:sequence` |

The Primary Status Comment is the first Symphony-managed comment created for a
Root, not necessarily the first user comment chronologically. Completion means
the Performer Turn produced a closed Result; it does not mean the Root or Work
is complete.

### Single event transport

```text
Performer Turn process
  |-- stdout: closed PerformerTurnEvent NDJSON frames, flushed live
  |-- stderr: sanitized diagnostics only
  `-- result file: one atomically published closed PerformerTurnResult

GlobalPerformerLane
  -> bounded stdout chunk callback
  -> Performer event stream decoder
  -> validate contract + Turn/Root/Work/sequence correlation
  -> Conductor observation projection queue
```

There is no `turn-events.ndjson`, `--event-path`, result-side `events` array, or
post-exit event replay. Conductor supplies `event_sequence_start` for retries of
the same Turn and advances it only from validated frames.

### Observation isolation

- Status writes use the saved Primary comment ID without comment revision or
  Root `updatedAt` preconditions.
- Timeline writes omit `comment_id`, carry an exact event marker, and append
  unless the event key already exists.
- Root title/description hash, Root state, phase labels, Work input hashes, and
  tree snapshots still protect Result application.
- Root `updatedAt` alone cannot reject a Result because comment writes may
  change it. Tests must still prove real Root input changes are rejected.
- Projection/logging failures are reported and swallowed at the observation
  boundary only. Contract or Result failures remain fail-closed.

## Dependency Graph

```text
Task 1: Primary Status observation fields (complete)
  -> Task 2: architecture source of truth
      -> Task 3: closed wire contracts
          -> Task 4: bounded stdout event decoder
              -> Task 5: single live Performer event transport
          -> Task 6: Linear SDK comment modes
              -> Task 7: Podium-Conductor mutation boundary
Task 5 + Task 7
  -> Task 8: real-time Primary Status projection
      -> Task 9: Timeline projection and failure isolation
          -> Task 10: core-live comment evidence
              -> Task 11: full verification, local E2E, and PR
```

## Task Order

### Phase 1: Define one model

- [x] Task 1: Persist Primary Status Turn observation fields.
- [ ] Task 2: Replace the architecture text with the two comment modes and one
      live event route.
- [ ] Task 3: Close and generate the Performer Event and Root comment mutation
      contracts.

### Checkpoint A: Contract

- [ ] Architecture tests and contract generation/checks pass.
- [ ] No event file, replay ledger, Linear credential, or comment ID appears in
      the Performer contract.
- [ ] Human review confirms the status/Timeline event mapping.

### Phase 2: Production boundaries

- [ ] Task 4: Add a bounded, correlated Performer stdout event decoder.
- [ ] Task 5: Switch Performer Turns to the single live stdout route and remove
      event-file collection.
- [ ] Task 6: Implement ID-upsert and event-key-append in `LinearSdkImpl`.
- [ ] Task 7: Expose both modes through the closed Podium-Conductor mutation.

### Checkpoint B: Boundaries

- [ ] Performer events are observed before the child process exits.
- [ ] A Root with more than 64 comments still supports status upsert and
      Timeline deduplication through bounded pagination or targeted lookup.
- [ ] Arbitrary user comments cannot be overwritten.

### Phase 3: Conductor projection

- [ ] Task 8: Project continuous events to the saved Primary comment ID.
- [ ] Task 9: Append Timeline events and isolate projection failures from
      Result handling.

### Checkpoint C: Runtime

- [ ] Primary status mutation happens while the Performer is still running.
- [ ] Error and completion events append once per event key.
- [ ] Observation writes do not refresh Root snapshots or invalidate an
      otherwise current Result.
- [ ] Structured logs identify Turn, Root, Work, sequence, event kind, and a
      sanitized reason without secrets.

### Phase 4: Real acceptance

- [ ] Task 10: Add Root comment evidence to the existing core-live runner.
- [ ] Task 11: Run all checks, pass local core-live E2E, then create and observe
      the GitHub Actions PR run.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| stdout contains non-event output | High | Reserve Turn stdout for closed frames; diagnostics use stderr; reject and log malformed frames |
| observation queue blocks Provider | High | Drain stdout immediately; serialize Linear writes outside the Provider callback; bound frames and bytes |
| Timeline growth breaks Root reads | High | Direct lookup for ID-upsert; bounded pagination for event-key search; tests above 64 comments |
| status update overwrites a user comment | Critical | Verify comment belongs to the Root and both old/new bodies carry the Primary managed identity |
| duplicate append after ambiguous Linear response | Medium | Exact event marker read-back before retry; return `already_applied` only for matching body |
| comment write makes Result stale | High | Remove Root `updatedAt` equality only; retain state, phase, hashes, tree, ownership, and profile checks |
| completion comment overstates workflow state | Medium | Label it as Performer Turn completion and state that Result/Linear/Git remain authoritative |

## Completion Gate

- Exactly one production event route exists and the event-file route is gone.
- Exactly one Primary Status Comment exists per active Root and is updated only
  by its saved Linear comment ID.
- Warning, error, and completion Timeline Comments append and deduplicate by
  `turn_id:sequence`.
- Observation failure cannot change a valid Performer Result or workflow
  decision.
- Focused tests, contract checks, `make lint`, `make typecheck`, `make test-all`,
  and `make build` pass.
- The local core-live E2E observes one Primary comment and deduplicated
  completion Timeline comments through real Linear.
- The branch is pushed only after local core-live passes; the PR's protected
  GitHub Actions run reaches a terminal result.
