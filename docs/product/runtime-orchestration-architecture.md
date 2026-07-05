# Runtime Orchestration Architecture

## Goal

This document fixes the target runtime architecture for Symphony orchestration.
It defines the long-lived owner of workflow state, the short-lived execution
boundary for Codex work, the signal flow for managed and direct modes, and the
rules that keep Linear, Conductor, and Performer responsibilities separate.

The intent is to remove ambiguity before refactoring. In particular, this
architecture resolves the questions of:

- where workflow phase state lives;
- who is allowed to talk to Codex;
- how human-intervention flows pause and resume;
- when Linear is webhook-driven versus polled;
- which runtime component owns durable execution memory.

## Core Decision

Symphony should treat **Conductor as the long-lived orchestration state owner**
and **Performer as a short-lived execution worker**.

Conductor owns the durable workflow phase state for each run. Performer owns the
execution of a single phase advancement, including Codex interaction, local
workspace work, and Linear projection writes needed for that execution.

In short:

- **Conductor decides what happens next.**
- **Performer does the work for one step.**
- **Workspace holds durable execution memory for a given issue.**
- **Linear is an external signal source and operator-facing projection, not the
  authority for orchestration state.**

## Runtime Roles

### Podium

Podium remains the public, internet-facing control plane for managed mode.

It is responsible for:

- receiving Linear webhooks for managed workspaces;
- owning managed-mode Linear credentials and proxy tokens;
- routing runtime events to Conductor over the existing outbound runtime
  channels;
- exposing operator UI, recent runs, and onboarding flows.

Podium should not own the fine-grained orchestration state machine for local
execution. It is the hosted coordination and visibility plane, not the stepwise
executor.

### Conductor

Conductor is the long-lived daemon in the customer environment.

It is responsible for:

- owning the durable phase state for each run;
- receiving work signals;
- deciding phase transitions;
- deciding when to invoke Performer;
- supervising short-lived Performer processes;
- persisting orchestration state across Performer crashes or restarts.

Conductor is the only component that should own the question:

> What phase is this run currently in, and what should happen next?

Conductor should not directly execute Codex work. It should not need to know
about Codex thread semantics, turn management, or sandbox-specific execution
logic.

### Performer

Performer is a short-lived worker process invoked by Conductor.

It is responsible for:

- executing one phase advancement request;
- talking to Codex;
- resuming or creating the Codex thread for the issue workspace;
- reading and writing the issue workspace;
- producing a structured phase result for Conductor;
- writing Linear-facing projections required by that execution path.

Performer should be the only runtime component that knows about Codex thread
identifiers, turn lifecycle, structured Codex output, and execution-specific
retry details.

### Workspace

Each issue workspace is the durable execution-memory boundary.

A workspace should hold:

- the checked-out repository state;
- local execution artifacts;
- durable per-issue execution metadata such as the Codex thread identifier;
- any phase-to-phase execution notes needed only by Performer.

This means Performer the process can remain short-lived and restartable without
losing the per-issue execution context that belongs with the repository work.

## State Ownership Rules

### 1. Conductor owns orchestration truth

Conductor is the single authority for workflow phase state.

Examples of orchestration state include:

- queued;
- implementing;
- awaiting human input;
- reviewing;
- reworking;
- done;
- failed.

This phase state must not depend on reading Linear labels back as the source of
truth. Linear may reflect the phase, but it must not define the phase.

### 2. Workspace owns execution memory

Execution memory that helps Performer resume or continue work belongs in the
workspace, not in Conductor phase state and not in Linear labels.

Examples include:

- Codex thread id;
- prior phase execution summary cached for the worker;
- local artifacts needed to continue work;
- repository-derived context.

### 3. Linear is a projection plus signal source

Linear serves two roles:

- an operator-facing projection surface;
- an external signal source for new work and human responses.

Linear should not be treated as the durable workflow-state database.

In practice, this means:

- Conductor persists the real phase state locally;
- Linear labels and comments mirror important outcomes for humans;
- human actions in Linear can trigger a state transition;
- Conductor should not reconstruct run state by scraping Linear labels.

## Managed and Direct Modes

Symphony should support two signal-ingress modes because the deployment physics
are different.

### Managed mode

Managed mode has a public Podium control plane.

Signal flow:

1. Linear sends a webhook to Podium.
2. Podium validates and translates the event.
3. Podium pushes a runtime event to Conductor over the outbound runtime channel.
4. Conductor updates phase state and invokes Performer if needed.
5. Performer executes one phase advancement and returns a structured result.
6. Conductor persists the next phase state.

Properties of managed mode:

- no polling of Linear is required;
- Conductor does not need managed Linear credentials;
- Podium is the internet-facing webhook receiver;
- Conductor remains a long-lived outbound client.

### Direct mode

Direct mode is a locally run daemon, typically started via service management
such as `systemctl`, bound to a specific workflow and Linear project.

Signal flow:

1. Conductor polls Linear for new work and relevant human-action updates.
2. Conductor maps those external changes into phase transitions.
3. Conductor invokes Performer to advance a phase.
4. Performer executes and returns a structured result.
5. Conductor persists the next phase state.

Properties of direct mode:

- polling is acceptable because there is no public webhook receiver;
- the local runtime owns the direct Linear integration for this mode;
- the same Conductor phase machine and Performer execution contract are reused;
- the difference from managed mode is signal ingress, not execution semantics.

## Human Intervention and Resume Model

Human-intervention flows such as runtime approval, missing information, or
verification questions should not hold an in-flight Codex turn open for hours or
days.

Instead, Symphony should model them as:

1. Performer ends the current turn cleanly and returns a structured result such
   as `needs_human` with a structured ask.
2. Conductor transitions the run into an `awaiting_human` phase.
3. The required human action is represented in Linear for operator visibility.
4. When the human resolves the action, Conductor receives the signal:
   - via Podium-pushed webhook events in managed mode;
   - via direct Conductor polling in direct mode.
5. Conductor invokes Performer again with the human answer or approval payload.
6. Performer resumes the workspace thread if possible and continues in a new
   turn.

This yields two important rules:

- **Conductor owns the long-lived waiting state.**
- **Performer owns short-lived Codex resume behavior.**

### Resume policy

Performer should preserve the Codex thread id in workspace state and attempt to
resume it when advancing the issue again.

However, resume must be best-effort, not a hard requirement. If the prior thread
cannot be resumed, Performer should start a new thread using:

- the current repository state;
- the persisted workspace execution notes;
- the prior phase result summary;
- the human answer or approval payload supplied by Conductor.

This keeps resume useful without making the architecture depend on indefinite
remote thread retention.

## Conductor–Performer Contract

Conductor and Performer should communicate through a stable contract owned by
`performer_api`, not by importing each other's implementation internals.

The contract should be phase-oriented, not turn-oriented.

Conductor should ask Performer to do something equivalent to:

> Advance this run from phase X using this workspace and these inputs.

Performer should return a structured phase result that tells Conductor what
happened and what kind of transition is now possible.

The contract must:

- avoid leaking Codex implementation details upward;
- avoid exposing thread ids to Conductor;
- carry human-action requests and human answers explicitly;
- support both managed and direct signal-ingress modes.

The contract should not make Conductor responsible for Codex turns,
continuations, or thread lifecycle details.

## Labels and Linear Projection Rules

Linear labels should be simplified and treated as projections of orchestration
state or gate outcomes, not as the database of record.

### Keep

- a reduced `performer:phase/*` family for operator-readable phase projection;
- `performer:type/*` only where the issue role is meaningful, such as gate,
  evidence, human action, and repository integration;
- `performer:gate/*` and score labels for acceptance/gate reporting.

### Remove or demote

Old lifecycle, dispatch, retry, and redundant human-subreason label axes should
not remain first-class Linear label families for run-state bookkeeping.

These details should move to structured runtime state, ops telemetry, or human
issue body content instead of being duplicated as parallel label axes.

## Run Epochs

If the same Linear issue is delegated again after its current Symphony run has
reached a terminal phase (`done` or `failed`), Conductor treats that signal as a
new iteration of the same issue, not as a silent duplicate. It creates a new
`run_id` with `epoch + 1`, preserves the prior run event log, and enforces that
only one non-terminal run for the issue can exist at a time.

Duplicate dispatches while a run is still non-terminal remain idempotent and are
recorded as duplicate events on the active run.

## Why this architecture fixes the current failure modes

This architecture addresses the current failure patterns directly:

- **Performer crash no longer destroys orchestration state** because Conductor
  owns the durable phase and can re-invoke Performer.
- **Linear label drift becomes less dangerous** because labels are projections,
  not the authority.
- **Human wait flows stop pretending to hold open a long-lived Codex turn** and
  instead become explicit phase transitions.
- **Conductor remains durable without becoming Codex-aware** because it owns the
  reducer, not the execution internals.
- **Performer remains focused** on execution, Codex handling, and workspace
  continuation.

## Rollout direction

The recommended implementation sequence is:

1. Define the phase-oriented request/response contract in `performer_api`.
2. Introduce Conductor-owned phase persistence and a pure phase-transition
   reducer.
3. Refactor Performer into an `advance`-style phase executor.
4. Preserve Codex thread ids in workspace-owned execution state.
5. Split managed and direct signal ingress while reusing the same downstream
   reducer and phase contract.
6. Simplify Linear labels so they project the new model instead of competing
   with it.

## Non-goals

This document does not require:

- moving Codex execution into Conductor;
- storing Codex thread ids in Conductor state;
- making Linear the source of truth for orchestration state;
- keeping a remote Codex turn suspended while waiting for human input;
- eliminating direct mode.

## Summary

The fixed architecture is:

- **Conductor** is the long-lived orchestration owner.
- **Performer** is the short-lived phase executor.
- **Workspace** is the durable execution-memory boundary.
- **Managed mode** uses webhook push through Podium.
- **Direct mode** uses local polling because there is no public webhook sink.
- **Linear** is a signal source and operator projection, not the phase database.

This gives Symphony a stable boundary for the upcoming refactor: state belongs
in Conductor, execution belongs in Performer, and long-lived human waits are
modeled as phase state rather than as suspended Codex turns.
