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
latest Critique checkpoint, optional Harness feedback, ordinary Root Inbox
comments after the cursor, the exact direct-reply batch for a pending Human
Action (when present), and a mechanical file/line summary. It never reads the
Cycle DAG, child descriptions/comments, Artist prose, or raw transcripts.
Critic remains the sole semantic authority for implementation quality even
though the process has workspace access for its other phases.

Its nonterminal decision is closed:

```text
create_cycle { objective, acceptance, boundaries, report }
needs_human { reason, questions[1..n], reply_disposition?, report }
```

Each question contains two to four concrete mutually exclusive options. Every
option has a stable key, a human label, and the consequence of choosing it.
Free-form-only questions, inferred yes/no choices, and missing options are
invalid. When Reconcile receives a direct-reply batch while Root is `Needs Human`, it
must classify the whole batch as `accepted` or `rejected`; partial acceptance is
not a contract. Rejection includes a concrete reason and can only lead to a new
`needs_human` decision. Acceptance may create a Cycle, complete, or expose a
new independent question.

### Human Action thread

`needs_human` creates exactly one pending Human Action thread for the Root. The
thread is a Root Harness question comment plus its native direct-reply thread;
it is not a child Issue, a second status machine, a repository document, or a
free-form chat channel. The request comment carries the validated question and
two to four options. Root State stores the pending `human_action` record until
one complete reply batch is classified.

Only a direct reply to the exact request comment answers the Human Action. A
normal top-level Root comment remains ordinary Inbox input and never answers,
accepts, rejects, or closes the pending Human Action. It is passed to a later
Reconcile as ordinary Root input; it cannot supply `reply_disposition` and it
does not advance the Human Action cursor. A reply batch is consumed as one
whole batch, receives one accepted or rejected disposition, and receives the
matching visible reaction receipt before its source IDs are advanced.

The first fresh Reconcile that sees an accepted direct-reply batch returns one
or more structured decision drafts alongside its next semantic decision. A
rejected batch returns no decision draft and keeps any supplemental questions
inside the existing thread. No model output may choose the record ID, timestamp,
or source IDs.

```text
architecture_decisions[1..n] {
  title,
  decision,
  rationale,
  consequences[]
}
```

Conductor appends the accepted decision to `RootState.architecture_decisions`
and writes the exact resulting array into the next immutable `CycleSpec` when
`next` is `create_cycle`. That Cycle receives a snapshot, not a live reference:
later Human Action answers are visible only to later Reconcile and later Cycles;
Artist and Critic cannot edit or reinterpret an earlier snapshot. An accepted
answer may therefore change the next Cycle's boundaries or acceptance, but it
cannot rewrite a completed Cycle's contract.

One Cycle contains exactly one Artist and one Critic. Ordinary Root Inbox
comments are consumed as one batch only after the complete family is durably
recorded. During an active Cycle, retain newer comments as pending for the next
Reconcile; ordinary comments remain Inbox input, while a Human Action
direct-reply batch remains scoped to its request thread and is never folded
into ordinary Inbox input.

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
Delivery preserves the Prepare-selected local history: any new delivery branch
starts at the workspace's current local `HEAD`, never by switching to, resetting
to, or recreating the branch from a remote base.

## Root State

Root State persists the prepared workspace binding, phase, compact trusted task
state, compact latest Critique checkpoint, one Harness warning, comment cursor,
exact token counters when available, optional pending `human_action`, the
append-only `architecture_decisions[]` record set, and optional structured
Delivery. `architecture_decisions[]` is required at the wire boundary and may
be empty; a missing field is invalid under this hard-cut contract. The full
Critique remains in its local/uploaded artifact rather than the Root checkpoint.

Each accepted architecture decision is a mechanical record, not a repository
ADR file:

```text
ArchitectureDecision {
  id: ADR-NNN,                      # assigned monotonically by Conductor
  title,
  decision,
  rationale,
  consequences[],
  source_action_comment_id,
  source_reply_ids[],
  decided_at: YYYY-MM-DD HH:mm:ss GMT+/-HH:MM
}
```

`id` is allocated from the current Root State sequence and never comes from the
Agent or the human. `decided_at` is the Conductor runtime's local clock value
and is presentation-only; it is not parsed for ordering. Source fields preserve
the action comment and complete ordered direct-reply batch. The record is
durable Root State only; this design creates no repository ADR file.

The Harness-managed Root description contains one replaceable metadata block,
latest validated Reconcile report, local-offset update time, and, after
delivery, a mechanically rendered human-visible `## Delivery` section.

## Status projection

Root uses the canonical `Needs Human`/`started` status in addition to the five
statuses shared with descendants. Prepare remains metadata rather than a
status.

```text
Todo -> In Progress -> In Review -> Needs Human -> In Progress -> Done
```

The first fresh Reconcile starts from `Todo`; an active durable Cycle is
`In Progress`; a terminal Critic is `In Review`; a concrete Reconcile question
is `Needs Human`. A resumed Reconcile leaves the Root there until its decision
is known. Conductor sets Root `Done` only after a valid Delivery is durably
projected.

## Permissions

| Capability | Allowed | Forbidden |
|---|---|---|
| workspace | Prepare binding, final delivery, and mechanical reporting | using self-inspection to overrule Critic quality judgment |
| Linear | none directly | GraphQL, child-tree reads, Issue mutation, or comment rendering |
| context | Root State, ordinary Inbox, and direct Human replies | child DAG, role output, diagnostics, hidden state, or top-level fake replies |
| delivery | required PR, branch, files fallback order | skipping available remote delivery; automatic merge, destructive cleanup, or invented locations |
