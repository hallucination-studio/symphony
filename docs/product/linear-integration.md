# Linear Integration: Fixed App Polling Core

Status: accepted architecture calibration on 2026-07-15. This document defines
the target product; it does not claim that every target slice is implemented.

## 1. Decision

Symphony uses one fixed public Linear app, a local OAuth callback, and outbound
polling. Linear is the customer task surface and operator-visible projection;
it is not Symphony's scheduler or execution source of truth. Podium remains the
only Linear client. The existing dispatch pool, one-project Conductor,
Managed Run harness, ordered Sub Issues, runtime waits, verification, Gate,
rework, and fencing rules remain authoritative. `[D01] [D02] [D03]`

The design has no inbound business-event endpoint and no Linear-native agent
interaction path. A loopback OAuth callback is retained because it completes a
human-initiated local authorization attempt; it is not a webhook or a runtime
intake path. `[D01] [D04]`

Codex progress may be exposed upward only as the closed `performer_event`
contract. It is an advisory Podium status signal, never raw provider output,
never a Linear command, and never workflow truth. `performer_kind` is the
singleton `codex`; this design introduces no model selector, fallback, review
route, or cross-model vocabulary. `[D05] [D06]`

### Scope ledger

| Field | Record |
|---|---|
| `authorized` | Fixed Linear app; S256 PKCE; local callback; plaintext Linear access/refresh tokens in Podium-owned `podium.db`; project selection; outbound polling; current pool/harness; parent/Sub Issue/Human Action/Gate projection; Codex-only closed `performer_event` in Podium. |
| `required_consequences` | Installation metadata and its token pair commit atomically; restart/update reuse the database; installation and credential health remain separate states; all pagination and checkpoints are durable; one delegation epoch creates at most one dispatch; live events are bounded, sanitized, fenced, and advisory; failures remain visible. |
| `out_of_scope` | Linear app configuration revision, mutation, candidate, cutover, or migration; OS credential store or Keychain; application encryption/key/ciphertext; memory-only credentials; credential migration or dual storage; public ingress; webhook relay; tunnel; custom Linear app form; distributed client secret; personal API key fallback; mention intake; raw Codex streaming; provider choice; second scheduler; pool changes; automatic app removal; and live-event projection into Linear. |
| `assumptions_requiring_approval` | None. Any inbound architecture, new provider, or new customer control path is a separate product decision. |
| `deferred_ideas` | None. Removed scope is not an implied roadmap. |

## 2. Customer contract

The supported workflow is deliberately short: `[D07]`

1. The customer opens Podium Desktop and chooses **Connect Linear**.
2. A workspace admin installs the fixed Symphony app.
3. The customer selects projects and binds one repository/Conductor to each.
4. A human delegates a root issue to the Symphony app user.
5. Podium discovers the delegation by polling and queues one dispatch.
6. Conductor creates or resumes one Managed Run.
7. Linear shows the ordered Sub Issues, current work, runtime waits, Gate
   result, rework or block, and final state.
8. Podium may additionally show a concise live status derived from
   `performer_event`.

The customer never configures a callback URL, webhook, client secret, provider,
queue, pool, cursor, or event mapping. **Connected** means all of the following:

- the workspace app installation exists;
- Podium owns a complete refreshable credential in `podium.db`;
- `viewer` verifies the expected app actor, organization, app-user id, and
  required scopes;
- every selected project is accessible to that installation.

A Linear **Manage** button proves only that the workspace app already exists.
It does not prove that this Podium profile owns a credential and is never
treated as authorization success. `[D02] [V01]`

## 3. Authority and runtime boundaries

```text
Linear
  delegated root issue
       |
       | outbound polling only
       v
Podium Desktop / local Podium process
  podium.db: installation metadata + plaintext access/refresh tokens,
             projects, checkpoints, delegation epochs, dispatches,
             bindings, leases, failures
       |
       | project-bound dispatch lease and bounded reports
       v
Conductor
  workflow.db: Managed Run, plan revisions, ordered work items,
               turns, runtime waits, evidence, Gate, terminal state
       |
       | one fenced turn
       v
Performer -> Codex
  closed final result ---------> workflow truth
  closed performer_event ------> advisory Podium live status

Conductor truth -> Podium-owned Linear projection
  parent + ordered Sub Issues + [Human Action] + Gate/final status
```

Authority is fixed: `[D03] [D05]`

| Object | Owner | Authority |
|---|---|---|
| Linear installation, token, selected projects, polling checkpoint, delegation epoch, dispatch and lease | Podium | Authenticate, observe, deduplicate, route, proxy, and project |
| Managed Run, approved plan revision, work-item order, runtime wait, verification, Gate and terminal state | Conductor | Decide what work may run and whether it passes |
| One fenced Codex turn | Performer | Execute the requested turn and return closed contracts |
| Parent/Sub Issue/Human Action content | Podium projection of Conductor truth | Display and accepted human-action input only |
| `performer_event` | Performer emits; Conductor validates; Podium displays | Advisory status only |

No event can create or reorder a work item, approve a plan, resolve a wait,
pass a Gate, retry an attempt, or complete a run. Dropping every live event must
leave the Managed Run result unchanged. `[D05]`

## 4. Fixed app installation and authorization

### 4.1 Manifest and permissions

Symphony ships one fixed public app configuration whose public client id comes
from the required `LINEAR_CLIENT_ID` process environment, with a fixed loopback
redirect, `actor=app`, S256 PKCE, and exact scopes
`read`, `write`, and `app:assignable`. The desktop contains no Linear client
secret and exposes no custom-app form. Workspace installation and later project
selection are separate operations. `[D02]`

The process environment supplies only the release-owned public client id; the
browser, UI, and SQLite cannot supply or mutate it. Release code owns the
redirect URI, actor, and scopes. Missing or empty `LINEAR_CLIENT_ID` fails
readiness. The MVP stores no manifest/config revision and
has no application-configuration mutation, migration, candidate, cutover, or
compatibility path. A future change requires a new product decision rather
than a dormant runtime branch. `[D02]`

### 4.2 First installation

The formal flow is: `[D02] [D08]`

1. Tauri asks local Podium to begin authorization.
2. Podium binds the fixed loopback listener and creates one high-entropy,
   single-use `state`, PKCE verifier, and S256 challenge.
3. Tauri opens the system browser with the fixed authorization request.
4. The admin approves the workspace app installation.
5. Linear redirects to the loopback listener. Podium requires an exact,
   unexpired state match and exchanges the one-use code without a client
   secret.
6. Podium verifies `viewer.app=true`, organization identity, workspace app-user
   id, exact required scopes, and fully paginated project access.
7. Podium commits installation metadata and the access/rotating-refresh pair
   to `podium.db` in one transaction and only then records **Connected**.
8. The listener closes. The browser receives only a safe completion result.

Only one authorization attempt may be active. State mismatch, expired state,
duplicate callback, callback timeout, wrong actor, missing scope, failed
`viewer`, inaccessible selected project, or unavailable SQLite storage
fails closed with a durable sanitized reason. Browser navigation or button text
never changes connection state. `[D02] [D08]`

Authorization codes, PKCE verifiers, cookies, Authorization headers, and raw
external errors never enter SQLite, React responses, logs, reports, or Linear.
Access/refresh tokens enter only the approved Podium installation columns;
they never enter ordinary records or query results outside the credential
repository, snapshots, API or Tauri responses, Conductor/Performer contracts,
logs, reports, artifacts, or Linear. `[D09]`

### 4.3 Startup and refresh

Podium does not open a browser on normal startup. It reads the credential from
`podium.db`, verifies a usable access token with `viewer`, or refreshes an
expired token using the fixed public client id and rotating refresh token. The
replacement access and refresh pair commits in one SQLite transaction before
it becomes the active in-memory credential. Normal service restart and
application update reopen the same app-data database. One refresh-and-retry is
allowed after a Linear `401`; repeated failure becomes
`reauthorization_required`. `[D02] [D09]`

```text
disconnected
  -> authorization_pending
  -> connected
  -> reauthorization_required
  -> disconnected                 # explicit disconnect/revocation
```

Refresh failure stops new polls and dispatches for that installation, preserves
existing durable runs, and exposes the sanitized reason and next action in
Podium health and logs. It does not silently substitute a client secret,
personal token, or another OAuth client. `[D09]`

### 4.4 Existing installation without a local credential

The workspace app and the local OAuth credential are distinct. In the verified
flow, reopening authorization for an already-installed fixed app displayed
**Manage**; selecting it produced no loopback callback and the bounded local
attempt timed out. `[V01]`

Podium represents this as:

```text
credentials_missing_for_existing_installation
```

It closes the listener at the timeout, records
`linear_existing_installation_credentials_missing`, and offers only:

1. **Open Linear app settings** — management only; it never reports Connected.
2. **Reset and reconnect** — explain that workspace removal invalidates the
   current app identity/credentials, require explicit admin confirmation, open
   the removal surface, and start a fresh installation only after removal.

Podium never removes a workspace app automatically and never waits
indefinitely for **Manage** to behave like authorization. `[D08] [V01]`

### 4.5 Minimal installation record

One Podium-owned SQLite record stores the installation and credential: `[D09]`

```text
installation_id
organization_id
app_user_id
granted_scopes
access_token
refresh_token
expires_at
status
last_verified_at
sanitized_error_code
```

`access_token` and `refresh_token` are the only approved secret-bearing SQLite
fields. They are not part of the ordinary installation DTO returned to the UI
or another role. There is no application-secret column, credential reference,
OS credential adapter, custom token encryption layer, separate token file,
dual store, or `installed=true` shortcut for readiness.

## 5. Projects, polling, and dispatch

### 5.1 Project binding

Project discovery follows all cursor pages. A customer may select multiple
projects visible to the installation, but each selected project has at most one
active Conductor, and each Conductor binds exactly one project and repository.
Stable Linear ids are routing truth; project names, slugs, human assignees, and
labels are display metadata. Project selection never mutates project
membership. `[D01] [D03]`

Adding an accessible project does not repeat OAuth. An unbound project may be
deselected directly; a bound project must be unbound after active work is
settled. `[D03]`

### 5.2 Reliable outbound polling

Polling is the only production intake path. A new binding performs a complete
baseline before incremental scans. Incremental scans include delegated and
no-longer-delegated issues in the selected project so ownership transitions
cannot disappear. Parent/projection issues are excluded before dispatch.
`[D01] [D03]`

Every scan:

- follows `pageInfo.hasNextPage` and `endCursor` to exhaustion;
- overlaps the timestamp boundary and orders observations by
  `(updatedAt, issue_id)`;
- verifies organization, project, active installation app-user id, issue
  eligibility, blockers, and binding health;
- commits observations, delegation state, idempotency keys, new dispatches,
  and the page checkpoint in one transaction;
- advances the final high-water mark only after the complete scan commits.

A crash resumes from the last committed checkpoint. A continuously observed
delegation reuses one delegation epoch and one dispatch idempotency key. Only a
durably observed non-delegated transition closes the epoch; a later delegation
opens a new epoch and may dispatch the same durable Managed Run again.
`[D01] [D03]`

### 5.3 Pool and routing invariants

The existing pool is unchanged. Podium queues eligible dispatches; the unique
project-bound Conductor leases them under existing heartbeat, expiry, reclaim,
and fencing rules. Routing requires the active installation, organization,
selected project, app user, unique binding, repository, eligible issue,
blockers, and healthy runtime to agree. It never routes by label or human
assignee. `[D03]`

A poll or proxy failure retains the last safe checkpoint, retry count,
sanitized reason, and next attempt. Retry uses bounded exponential backoff with
jitter. No error advances a checkpoint or becomes an invisible indefinite
wait. `[D10]`

## 6. Managed Run and Linear projection closure

The end-to-end control loop is: `[D03] [D07]`

```text
delegate root issue
  -> observe delegation epoch
  -> queue and lease one dispatch
  -> create/resume one Managed Run
  -> approve one plan revision
  -> create ordered Sub Issues
  -> run one eligible fenced turn
  -> verification commands
  -> read-only selected-backend Gate
  -> pass, one rework, or visible block
  -> settle Sub Issue and parent projection
```

Conductor's `workflow.db` remains execution truth. Linear shows only bounded,
sanitized projections:

- parent: concise plan and lifecycle state;
- Sub Issue: objective, acceptance criteria, safe file scope, state, and Gate
  summary;
- `[Human Action]`: the recorded runtime approval, permission, or tool-input
  wait and its accepted resolution path;
- Gate/final state: pass/fail, score/threshold, rework remaining or blocked,
  and terminal summary.

Repeated polls and restarts reuse the same run and Linear child ids. Projection
failure never changes execution truth. A terminal failure must agree across
durable state, the managed-runs API/view, structured logs, and the relevant
Linear operator surface. `[D07] [D10]`

## 7. Closed Codex `performer_event`

### 7.1 Customer purpose

The live signal answers two questions in Podium: “is this turn still alive?”
and “which safe phase is it in?” It does not reproduce the Codex transcript or
create a second task history. Linear remains intentionally low-frequency and
receives only the workflow projections in section 6. `[D05] [D07]`

### 7.2 Contract

Performer normalizes provider data before it crosses its process boundary. The
inner `PerformerTurnEvent` stays closed:

```json
{
  "protocol_version": 1,
  "kind": "progress | warning | heartbeat",
  "message": "allowlisted semantic text",
  "sequence": 4
}
```

Conductor validates the event against the frozen turn request and adds trusted
correlation and source fields. Every upstream consumer sees one discriminator:

```json
{
  "type": "performer_event",
  "protocol_version": 1,
  "context": {
    "run_id": "...",
    "task_id": "...",
    "attempt_id": "...",
    "turn_kind": "execute",
    "fencing_token": 7
  },
  "source": {
    "performer_kind": "codex",
    "performer_binding_id": "...",
    "binding_generation": 3
  },
  "event": {
    "kind": "progress",
    "message": "Checking the current task.",
    "sequence": 4
  }
}
```

`performer_kind` is provenance, not a routing switch. Its only accepted value
is `codex`. Provider event names, internal instructions, reasoning, commands,
tool names/arguments/results, paths, diffs, stdout/stderr, usage, provider ids,
request bodies, exceptions, and arbitrary metadata are rejected. Customer text
comes from a small semantic allowlist such as “Planning the work”, “Working on
the current task”, “Checking the current task”, and “Still working”. `[D05]
[D06] [D09]`

The current Codex adapter's label-based final-event normalization is not
sufficient for this customer contract. The implementation slice must replace
it with explicit semantic mapping and tests before Podium calls it live
progress. `[V02]`

### 7.3 Live transport

`PerformerTurnResult.events` is currently a bounded final batch, not proof of
pre-final streaming. The live slice begins with a real Codex integration test
that demonstrates callbacks before the final result. If callbacks are not
available, Podium uses durable turn state and lifecycle heartbeats and does not
invent provider progress. `[V02]`

After that proof, the smallest transport is:

1. Conductor creates one bounded inherited local pipe for the one-shot
   Performer turn.
2. Performer writes only validated JSON-line `PerformerTurnEvent` frames.
3. Conductor rejects wrong-version, malformed, oversized, out-of-order, stale,
   or wrong-fence frames.
4. Conductor keeps only the latest accepted event and counters in memory and
   forwards it through the bounded Podium report path.
5. Podium exposes the latest safe value in its local managed-run view.
6. The pipe closes with the turn; the final result path remains the only
   business-result path.

The pipe is bounded and non-blocking from the business result's perspective.
Backpressure may coalesce or drop progress, never block completion. There is no
event journal, broker, outbox, replay API, new database table, public listener,
or Linear write for live events. Restart may lose the ephemeral latest value;
the durable run/turn state remains correct. `[D04] [D05]`

Conductor still emits correlated lifecycle heartbeats often enough that a real
run does not appear dead for more than one minute. A malformed or absent live
stream is visible as a degraded status but cannot fail an otherwise valid final
result. `[D05] [D10]`

## 8. Failure and recovery contract

| Failure | Required behavior |
|---|---|
| OAuth denied or callback timeout | Close the bounded attempt; preserve prior healthy state; store and show the exact sanitized category. |
| `podium.db` unavailable or corrupt | Fail readiness visibly; never open a second credential store. After restore/reset, any lost credential follows the existing authorization recovery flow. |
| Existing workspace app but no local credential | Show `credentials_missing_for_existing_installation`; require explicit admin reset before a new installation. |
| Refresh rejected or credential revoked | Stop new polling/dispatch, preserve durable runs, and show `reauthorization_required`. |
| Project inaccessible | Block only that selection/binding with the project-scoped reason. |
| Poll page or checkpoint write fails | Keep the last committed checkpoint and retry with visible count, reason, and next action. |
| Duplicate delegation observation | Reuse the epoch and dispatch key; never create a second run. |
| Conductor offline or lease stale | Use existing reclaim and fencing; preserve work in `workflow.db`. |
| Performer setup/turn/result fails | Persist the concrete error code and next action; never reduce it to generic `failed`. |
| Runtime input required | Persist the wait and project the existing `[Human Action]` surface. |
| Gate fails | Allow the existing single rework; a second failure blocks visibly. |
| Live frame invalid or stale | Reject, count, and log a correlated warning; keep final-result eligibility. |
| Codex pre-final callback unavailable | Display live progress unavailable; use durable lifecycle state and heartbeats. |
| Linear projection fails | Retry the idempotent projection; never rewrite Managed Run truth. |

Every failure that changes durable state has a structured log with correlation
ids, sanitized reason, retryability, attempt count where applicable, required
action, and next action. Secrets are redacted without erasing the error
category. `[D09] [D10]`

## 9. Ordered delivery

1. **Fixed authorization.** Complete the fixed app configuration, S256 PKCE
   loopback flow, atomic SQLite credential persistence, refresh-first startup,
   restart/update reuse, bounded callback failures, and explicit
   existing-installation recovery.
2. **Polling core.** Prove full baseline/incremental pagination, atomic
   checkpoints, delegation epochs, project binding, blockers, one dispatch, and
   restart recovery.
3. **Managed Run closure.** Prove delegation through plan/Sub Issues,
   Performer, verification, Gate, one rework or block, waits, final projection,
   and failure visibility.
4. **Private local reporting.** Land the accepted Podium/Conductor inherited
   private channel and preserve the existing control semantics.
5. **Closed live status.** Prove pre-final Codex callbacks, replace label-based
   normalization with semantic mapping, add the bounded Performer pipe, expose
   only `performer_event`, and verify that event loss cannot affect results.

Each slice gets its own scope ledger, tests, real evidence, error visibility,
and rollback. The core is complete after step 3; live status cannot delay or
destabilize task execution. `[D03] [D05] [D10]`

## 10. Acceptance

The polling core is accepted only when:

- a clean desktop profile installs the fixed app through S256 PKCE and restarts
  without opening authorization again;
- a healthy stored refresh token rotates without a client secret;
- an installed app with no local credential times out visibly at **Manage** and
  reconnects only after an explicitly confirmed reset;
- token values exist only in the approved SQLite installation fields and are
  absent from browser/API/Tauri/Conductor/log/report/artifact/Linear output;
- project and issue queries exhaust all cursor pages;
- an atomic checkpoint and delegation epoch produce exactly one dispatch;
- one real Managed Run shows approved plan, ordered Sub Issues, current task,
  verification, Gate pass or one rework then block, runtime waits, and final
  state;
- restart, stale lease/result, `401`, rate limit, polling/proxy/projection
  failure, and Performer setup failure are durable and visible;
- existing pool and one-project Conductor semantics are unchanged;
- no configuration or UI implies an inbound runtime path exists.

The live-status slice has separate acceptance: a real Codex turn emits at least
one safe event before its final result; stale/malformed/oversized frames are
rejected; sequence and fencing hold; backpressure and event loss do not affect
the result; Podium shows only the semantic allowlist and `codex` provenance;
and Linear receives no live-event writes. `[D05] [V02]`

## 11. Verification evidence informing the design

### V01: fixed-app authorization, 2026-07-15

The formal test used the production-shaped fixed request: loopback callback,
`actor=app`, scopes `read,write,app:assignable`, and S256 PKCE. A clean install
returned the exact state, exchanged the code without a client secret, verified
an app viewer and accessible projects, and returned a rotating refresh token.
Refresh without a client secret rotated both values and the replacement pair
was revalidated. No token value was printed or committed. The probe's temporary
storage mechanism is not evidence for the accepted SQLite persistence path;
that path still requires its own restart/update proof.

An independent attempt with the app already installed displayed **Manage**.
After the human selected it, the exact-state loopback listener received no
callback and timed out after 240 seconds. After explicit app removal, a clean
install succeeded. This is the evidence for treating workspace installation
and local credential ownership as separate states.

### V02: current event gap

The shared contract already defines bounded `PerformerTurnEvent` values and the
Codex adapter returns them inside `PerformerTurnResult`. Current code derives
customer messages from provider event labels only after the backend result is
available. It does not yet prove pre-final delivery or the semantic allowlist
required by section 7. The design therefore gates the live claim on a real
callback-timing test rather than treating final-batch events as streaming.

## 12. Decision and source register

The register distinguishes official facts, repository invariants, empirical
evidence, and product choices. An external source supports only the cited fact;
it does not make Symphony's internal reliability policy a Linear requirement.

| ID | Kind | Decision and source |
|---|---|---|
| D01 | Product choice + existing invariant | Outbound polling is the sole runtime intake because this deployment has no public ingress. Pagination, delegation epochs, dispatch dedupe, and project routing follow [runtime pipeline](runtime-pipeline.md), [ADR-0001](../decisions/0001-linear-installations-and-single-project-conductors.md), and the [operating guide](../../AGENT.md). |
| D02 | Official fact + accepted target | Workspace app identity uses `actor=app`; delegation needs `app:assignable`; OAuth code/state and PKCE refresh are the authorization boundary. The fixed public configuration follows [Linear OAuth actor][linear-oauth-actor], [Linear OAuth2][linear-oauth], [OAuth manifests][linear-manifests], [Podium Desktop](podium-desktop.md), and [ADR-0007](../decisions/0007-podium-desktop-local-boundaries.md). The MVP deliberately has no app-config revision or mutation lifecycle per [ADR-0009](../decisions/0009-freeze-linear-app-configuration-for-mvp.md). Credential persistence is the separate accepted decision in [ADR-0008](../decisions/0008-store-linear-tokens-in-podium-sqlite.md). |
| D03 | Repository invariant | Pool, Podium dispatch/lease, one-project Conductor, `workflow.db`, ordered work, Gate, waits, and fencing remain authority: [pipeline state](pipeline-state.md), [runtime pipeline](runtime-pipeline.md), [gates](gates-verification-integration.md), and [runtime profiles](runtime-profiles-backends.md). |
| D04 | User constraint + accepted target | No public business-event receiver, relay, or tunnel is allowed. The only callback is the local OAuth completion listener; runtime role communication follows the inherited private boundary in [Podium Desktop](podium-desktop.md) and [ADR-0007](../decisions/0007-podium-desktop-local-boundaries.md). |
| D05 | Existing contract + product choice | Only a bounded, closed and advisory event may cross Performer. Context/fencing comes from the frozen turn request; latest-value transport adds no workflow authority: [turn contracts](../../packages/performer-api/src/performer_api/turns.py), [runtime pipeline](runtime-pipeline.md), and [Podium Desktop](podium-desktop.md). |
| D06 | User choice + repository invariant | The only performer kind is `codex`; provenance is retained without creating provider routing or cross-model scope: [`PERFORMER_KINDS`](../../packages/performer-api/src/performer_api/turns.py) and the [Codex backend](../../packages/performer/src/performer/backends/codex.py). |
| D07 | Existing operator contract | Parent, ordered Sub Issues, runtime waits, Gate, and final state are the customer-visible closed loop: [Linear projection](linear-projection.md), [pipeline state](pipeline-state.md), and [gates](gates-verification-integration.md). |
| D08 | Official fact + empirical evidence + product choice | Callback code/state marks authorization success; an existing workspace installation is not proof of local credential ownership. Bounded Manage recovery follows [Linear OAuth2][linear-oauth], [OAuth actor][linear-oauth-actor], [Linear Security & Access][linear-security-access], and [V01](#v01-fixed-app-authorization-2026-07-15). |
| D09 | User decision + security invariant | Linear tokens persist only in the approved plaintext Podium SQLite fields; they are excluded from every outward contract and output. No OS store, custom crypto, memory-only fallback, migration, or dual store is allowed: [ADR-0008](../decisions/0008-store-linear-tokens-in-podium-sqlite.md), [security model](security-model.md), [Podium Desktop](podium-desktop.md), and the [operating guide](../../AGENT.md). |
| D10 | Reliability invariant | Failures must be durable, correlated, actionable, visible in the relevant API/view/log/Linear surface, and bounded under retry: [pipeline state](pipeline-state.md), [security model](security-model.md), and the [operating guide](../../AGENT.md). |
| REF | Reference implementation | The pinned official examples informed fixed app installation boundaries. Their public-inbound portions are intentionally not adopted: [weather-bot][weather-bot] and [managed-agent demo][managed-agent-demo]. |

[linear-oauth]: https://linear.app/developers/oauth-2-0-authentication
[linear-oauth-actor]: https://linear.app/developers/oauth-actor-authorization
[linear-manifests]: https://linear.app/developers/oauth-app-manifests
[linear-security-access]: https://linear.app/docs/security-and-access
[weather-bot]: https://github.com/linear/weather-bot/tree/2edbbe4193851bd579deff4e9d98cd518bea4a21
[managed-agent-demo]: https://github.com/linear/claude-managed-agents-demo/tree/7f3d6d477977dfc1cd15968f57cdd190efc16b11
