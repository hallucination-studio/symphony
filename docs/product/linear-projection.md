# Linear Projection

## Authority Boundary

Conductor's durable graph is scheduler truth. Linear is an operator-visible
mirror and human-event inbox. Conductor writes graph topology, status, attempts,
waits, and supersession to Linear, then ingests only allowed human events.

Linear comments are projection and context. They are never parsed as scheduler
commands.

## Issue Topology

The root business issue is immutable delegated intent and the status anchor for
the run. It is not a scheduler aggregate node.

Each graph node projects to one Linear issue or sub-issue. Parent/child nesting
expresses decomposition. Linear `blocks` relations mirror the DAG dependencies.
`blocks` remains a required dependency shape, but dependency satisfaction still
comes from upstream `VERIFY_PASSED >= 3` in Conductor.

## Ingestion

Linear ingestion is union-only and idempotent:

- start from current local `blocks` edges whose endpoints are live;
- add new human-created `blocks` edges;
- drop edges touching superseded nodes;
- validate the merged DAG before commit;
- commit nothing when topology is unchanged.

A lagging Linear read must not delete a live local edge. Deleting or rewiring
dependencies requires a validated topology change.

## Attempt Comments

Every attempt projects to exactly one status-bearing comment on its node issue.
The comment includes mode, attempt state, attempt id, backend thread id when
available, verify score, sanitized error summary, and links to safe evidence.

Idempotency is by durable projection mapping:

```text
attempt_id -> linear_comment_id
```

Reconcile updates the known `comment_id` when it exists and creates a comment
only when no mapping exists. There are no hidden comment markers; the durable
`comment_id` mapping is the replay key.

## need_human

Pipeline waits use `need_human` on the affected node. Entering `need_human`
moves the Linear issue to a blocked-style workflow state and posts one
instruction comment keyed by the wait identity and stored `comment_id`.

The instruction comment states:

- the structured reason the node stalled;
- what information or action the operator should provide;
- that comments are context only;
- that resume requires flipping the issue out of the blocked-style state.

The resume trigger is the state flip. A free-text comment alone never resumes
work.

Runtime approval, permission, and tool-input waits may still project as
`[Human Action]` child issues where that runtime wait flow uses child issue
completion as the resume signal. Those child issues are runtime wait artifacts,
not a replacement for node-level pipeline projection.

## Projection Health

The root issue carries a `symphony_pipeline` status comment. That block includes:

- `projection_healthy: true|false`;
- `last_successful_projection_at`;
- `last_projection_error` when the latest projection attempt failed.

Projection failures are durable state, not log-only warnings. If per-node
projection fails, Conductor records the sanitized error and makes a best-effort
root-status update before retrying on the next tick.

## Supersede Chains

When a node must return to planning, Conductor creates a new node and marks the
old node `SUPERSEDED`. Linear mirrors this as:

- old node issue moved to Canceled;
- new node issue created at the same parent level;
- upstream and downstream `blocks` inherited by the new node;
- visible `replaces` / `replaced-by` references between issues;
- an archived comment on the old issue with sanitized context.

The root business issue is not rewritten. Supersede chains grow beside the old
node so operators can see what ran, why it was replaced, and which node is now
active.

## Operator Fields

Projection payloads include stable metadata needed to join Linear to durable
state:

- graph id and graph revision;
- node id and parent node id;
- active policy id/version;
- gate snapshot hash;
- plan, execute, and verify attempt ids;
- operator status;
- operator wait kind;
- runtime wait id where present;
- linear projection id and last synced comment ids.

Metadata is sanitized. It must not include secrets, raw tokens, cookies,
passwords, or raw backend profile settings.

## Final Shape

```text
Root business issue (status anchor)
  [node] implement login        Done
    comment: plan#1 succeeded
    comment: execute#1 failed: <sanitized reason>
    comment: execute#2 succeeded
    comment: verify#1 passed score=3
  [node] implement logout v2    In Progress, replaces logout
  [node] implement logout       Canceled, replaced by logout v2

blocks: login -> logout v2
```

## Verification

A real run must prove the Linear tree matches durable state: node issues,
parentage, `blocks`, supersede links, attempt comments by `comment_id`,
`need_human` state flips, runtime wait child issues when used, projection health,
and sanitized error summaries.
