# Root Reconciliation

| Status | Owns | Does not own |
|---|---|---|
| target proposal | Prepare, next-Cycle reasoning, and final Delivery judgment | Cycle execution, Audit verdicts, Linear calls, or Podium scheduling |

Root Reconcile is one role with three phases:

```text
Prepare -> Reconcile -> (Cycle -> Execute -> Audit -> Reconcile)* -> Delivery
```

Prepare and Delivery are not separate roles or child Issues. Conductor launches
the role, validates its exact response, persists Root State, and projects Linear
status. Root Reconcile does not call Linear or choose provider status IDs.
If Root is already `Done`, return no-op after the team workflow-contract check;
do not start an Agent or mutate Root-owned resources. Conductor normalizes a
nonterminal Root to `Todo` before the first fresh Reconcile.

## Prepare phase

Before the first Cycle, Prepare returns the stable `workspace_path`, external
`run_directory`, and `root_branch`. With a preferred workspace it must use or
create that exact path; failure requires human attention and cannot fall back.
Without one it adopts the invocation current directory/current branch without
switching, cleaning, or resetting. Restart uses the persisted binding.

## Reconcile phase

Reconcile receives only the Root requirement, trusted Root State, the complete
latest typed Audit result, one pending finding, optional Harness feedback, new
Root comments after the cursor, and a mechanical file/line summary. It never
reads the Cycle DAG, child descriptions/comments, Executor prose, or raw
transcripts. Audit remains the sole semantic authority for implementation
quality even though the process has workspace access for its other phases.

Its nonterminal decision is closed:

```text
create_cycle { objective, acceptance, boundaries, report }
needs_human { reason, question?, report }
```

One Cycle contains exactly one Execute and one Audit. All new Root comments are
consumed as one batch only after the complete family is durably recorded.
During an active Cycle, retain newer comments as pending for the next Reconcile.

Root State keeps Pending Finding as one current Rejected/Failed summary and
Task State as compact progress promoted only from an accepted Audit. Conductor
parses the exact Audit result Markdown once, serializes its typed value to `cycle-NNN-audit-result.json`,
reads it back and validates it, then writes the re-read fields to `RootState.latest_audit`, promotes trusted
fields, and retains the result as the latest authority. Conductor writes the
Cycle Result as a separate mechanical projection. Cycle Result remains
a mechanical persistence and operator projection only.
Root Reconcile never receives the complete Root Issue tree, the managed Root snapshot, Cycle history/result comments, Cycle DAG, or role transcripts.

Root Reconcile uses its own independent role launch configuration. Reconcile,
Execute, and Audit agent/model/reasoning values never inherit from one another.

## Delivery phase

When trusted Audit state supports the complete Root requirement and the final
Inbox check is empty, Root Reconcile prepares the best available delivery and
returns:

```text
complete { summary, report, delivery }

delivery = pull_request | branch | files
```

Root Reconcile may use Git and installed `gh`. A local-files delivery is valid
when it names the absolute workspace and delivered files. Conductor must not
run Git commands, reinterpret the choice, or require remote publication.

## Root State

Root State persists the prepared workspace binding, phase, compact trusted task
state, latest Audit, one pending finding, one Harness warning, comment cursor,
exact token counters when available, and optional structured Delivery. Delivery
replaces the retired parallel `pull_request_url` and `delivery_branch` fields.

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
`In Progress`; a terminal Audit and later Root decisions are `In Review`.
Conductor sets Root `Done` only after a valid Delivery is durably projected.

## Permissions

| Capability | Allowed | Forbidden |
|---|---|---|
| workspace | Prepare binding, final delivery, and mechanical reporting | using self-inspection to overrule Audit quality judgment |
| Linear | none directly | GraphQL, child-tree reads, Issue mutation, or comment rendering |
| context | Root requirement, trusted Audit/Root State, new Root comments | child DAG, Executor output, raw diagnostics, hidden workflow state |
| delivery | Git/`gh` when useful, or explicit local files | automatic merge, destructive cleanup, or invented delivery locations |
