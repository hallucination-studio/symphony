# Root Reconciliation

| Status | Owns | Does not own |
|---|---|---|
| target proposal | Prepare, next-Cycle reasoning, and final Delivery judgment | Cycle execution, Critic verdicts, Linear calls, or Podium scheduling |

Root Reconcile is one role with three phases:

```text
Prepare -> Reconcile -> (Cycle -> Artist -> Critic -> Reconcile)* -> Delivery
```

Prepare and Delivery are not separate roles or child Issues. Prepare is a
deterministic `RootReconciler` phase; Reconcile and Delivery are fresh Agent
sessions. Conductor validates their results, persists Root State, and projects
Linear status. Root Reconcile does not call Linear or choose provider status IDs.
If Root is already `Done`, return no-op after the team workflow-contract check;
do not start an Agent or mutate Root-owned resources. Conductor normalizes a
nonterminal Root to `Todo` before the first fresh Reconcile.

## Prepare phase

Before the first Cycle, deterministic Prepare returns the stable
`workspace_path`, external `run_directory`, and `root_branch`. With a preferred
workspace it must use or create that exact path; failure requires human
attention and cannot fall back. Without one it adopts the invocation current
directory/current branch without switching, cleaning, or resetting. Restart
uses the persisted binding. Prepare performs no model call and produces no
model-authored report.

## Reconcile phase

Reconcile receives only the Root requirement, trusted Root State, the compact
latest Critique checkpoint, optional Harness feedback, new
Root comments after the cursor, and a mechanical file/line summary. It never
reads the Cycle DAG, child descriptions/comments, Artist prose, or raw
transcripts. Critic remains the sole semantic authority for implementation
quality even though the process has workspace access for its other phases.

Its nonterminal decision is closed:

```text
create_cycle { objective, acceptance, boundaries, report }
needs_human { reason, question?, report }
```

One Cycle contains exactly one Artist and one Critic. All new Root comments are
consumed as one batch only after the complete family is durably recorded.
During an active Cycle, retain newer comments as pending for the next Reconcile.

Root State keeps Task State as compact progress promoted only from an accepted
Critic. Conductor parses the compact machine envelope in the Critic Markdown
once, creates the full Critique artifact in memory, serializes those exact bytes
once to `cycle-NNN-critique-result.json`, and uploads the same bytes. It promotes
only verdict, task state, one pending finding, and artifact URL into
`RootState.latest_critique`; it does not reread its own artifact. Cycle
Result remains a mechanical operator projection only.
Root Reconcile never receives the complete Root Issue tree, the managed Root
snapshot, either Cycle comment, the Cycle DAG, or role transcripts.

Root Reconcile uses its own independent role launch configuration. Reconcile,
Artist, and Critic agent/model/reasoning values never inherit from one another.

## Delivery phase

When trusted Critic state supports the complete Root requirement and the final
Inbox check is empty, Root Reconcile prepares the best available delivery and
returns:

```text
complete { summary, report, delivery }

delivery = pull_request | branch | files
```

Root Reconcile must attempt delivery in strict order: commit/push and create or
locate a pull request with installed Git and `gh`; if that attempt fails, verify
and return the pushed remote branch; only if both remote attempts fail, return
local files that exist in the named workspace. Change size or perceived need
never permits skipping a higher-priority delivery. Conductor validates the
returned value but does not run Git commands or reinterpret the attempt results.

## Root State

Root State persists the prepared workspace binding, phase, compact trusted task
state, compact latest Critique checkpoint, one Harness warning, comment cursor,
exact token counters when available, and optional structured Delivery. The full
Critique remains in its local/uploaded artifact rather than the Root checkpoint.

The Harness-managed Root description contains one replaceable metadata block,
latest validated Reconcile report, local-offset update time, and, after
delivery, a mechanically rendered human-visible `## Delivery` section.

## Status projection

The same five canonical Linear statuses apply to Root and descendants. Prepare
is metadata, not a sixth status.

```text
Todo -> In Progress -> In Review -> Done
```

The first fresh Reconcile starts from `Todo`; an active durable Cycle is
`In Progress`; a terminal Critic and later Root decisions are `In Review`.
Conductor sets Root `Done` only after a valid Delivery is durably projected.

## Permissions

| Capability | Allowed | Forbidden |
|---|---|---|
| workspace | Prepare binding, final delivery, and mechanical reporting | using self-inspection to overrule Critic quality judgment |
| Linear | none directly | GraphQL, child-tree reads, Issue mutation, or comment rendering |
| context | Root requirement, trusted Critic/Root State, new Root comments | child DAG, Artist output, raw diagnostics, hidden workflow state |
| delivery | required PR, branch, files fallback order | skipping available remote delivery; automatic merge, destructive cleanup, or invented locations |
