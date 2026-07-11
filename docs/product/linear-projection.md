# Linear Projection

## Authority Boundary

Conductor's durable managed-run store is scheduler truth. Linear is an
operator-visible mirror and human-event inbox. Conductor writes run status,
work-item contracts, attempts, waits, and approved revision state to Linear, then
ingests only allowed human events.

Linear comments are projection and context. They are never parsed as scheduler
commands.

## Issue Topology

The root business issue is immutable delegated intent and the status anchor for
the run. It is not a scheduler aggregate node.

Each accepted work item projects to one Linear child issue. Parent/child nesting
expresses the managed-run plan. Linear `blocks` relations may mirror work-item
dependencies for operator readability, but dependency satisfaction comes only
from Conductor work-item state: dependencies must be Done.

## Dependency Observation Gap

Inbound human-created `blocks` relations do not currently change execution
readiness. The former direct-unit implementation was never connected to the
installed Conductor path and rewrote accepted work-item payloads, so it is not a
supported ingestion contract or acceptance proof.

C1.2 and C3.1 will close this gap with typed Linear observations and a versioned
immutable `DependencyOverlay`. The target behavior will:

- preserve the accepted plan and its dependency hash;
- append validated human-created `blocks` edges in an overlay;
- reject cycles, stale versions, partial observations, and changes to started
  targets;
- derive effective readiness from plan dependencies union the active overlay;
- commit nothing when the effective topology is unchanged.

A lagging or partial Linear read must not delete a live overlay edge. Until that
contract is implemented and accepted, inbound dependency changes remain an
explicit product gap.

## Attempt Comments

Every attempt projects to exactly one status-bearing comment on its work-item
issue. The comment includes turn kind, attempt state, attempt id, backend thread id when
available, verify score, sanitized error summary, and links to safe evidence.

Idempotency is by durable projection mapping:

```text
attempt_id -> linear_comment_id
```

Reconcile updates the known `comment_id` when it exists and creates a comment
only when no mapping exists. There are no hidden comment markers; the durable
`comment_id` mapping is the replay key.

## Human Action

Managed Runs use blocked parent or work-item state for operator action. Entering
a blocked state moves the relevant Linear issue to a blocked-style workflow
state and records one instruction update keyed by the managed-run wait identity.

The instruction comment states:

- the structured reason the run or work item stalled;
- what information or action the operator should provide;
- that comments are context only;
- that resume requires flipping the issue out of the blocked-style state.

The resume trigger is the state flip. A free-text comment alone never resumes
work.

Runtime approval, permission, and tool-input waits may still project as
`[Human Action]` child issues where that runtime wait flow uses child issue
completion as the resume signal. Those child issues are runtime wait artifacts,
not a replacement for work-item-level Managed Runs projection.

## Projection Health

The root issue carries a Managed Runs summary block. That block includes:

- `projection_healthy: true|false`;
- `last_successful_projection_at`;
- `last_projection_error` when the latest projection attempt failed.

Projection failures are durable state, not log-only warnings. If per-node
projection fails, Conductor records the sanitized error and makes a best-effort
root-status update before retrying on the next tick.

## Plan Revisions

When implementation needs changed scope, dependencies, acceptance criteria, or a
human decision, Conductor records a new plan version only after approval. Linear
mirrors the approved revision as:

- unchanged work-item issues updated in place;
- removed work-item issues moved to Canceled;
- new work-item issues created under the same parent;
- dependency `blocks` refreshed from the approved plan;
- visible revision context with sanitized reason and plan version.

The root business issue is not rewritten. Operators can see what ran, why the
plan changed, which work items were canceled, and which work items are active.

## Operator Fields

Projection payloads include stable metadata needed to join Linear to durable
state:

- run id and plan version;
- work item id and parent issue id;
- active policy id/version;
- plan, work-item, and verification attempt ids;
- operator status;
- operator wait kind;
- runtime wait id where present;
- linear projection id and last synced comment ids.

Metadata is sanitized. It must not include secrets, raw tokens, cookies,
passwords, or raw backend profile settings.

## Final Shape

```text
Root business issue (status anchor)
  [work item] implement login        Done
    comment: plan#1 succeeded
    comment: work-item#1 failed: <sanitized reason>
    comment: work-item#2 succeeded
    comment: verification passed
  [work item] implement logout v2    In Progress
  [work item] implement logout       Canceled by approved revision

blocks: login -> logout v2
```

## Verification

A real run must prove the Linear tree matches durable state: work-item issues,
parentage, dependency `blocks`, approved revision effects, attempt comments by
`comment_id`, blocked-state flips, runtime wait child issues when used,
projection health, and sanitized error summaries.
