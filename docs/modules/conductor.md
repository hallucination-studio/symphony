# Module baseline: `conductor`

Status: implemented baseline, 2026-07-12. Runtime/Web compatibility owners
remain separate until their behavior is covered by the real flow.

## Responsibility

Conductor is the customer-side daemon for exactly one Linear project and one
repository. It leases dispatched parent issues over HTTP, keeps the local
workflow durable, launches Performer turns, creates and updates Linear child
issues, runs acceptance gates, and reports a sanitized view to Podium. It is
the only local process manager for Performer.

Conductor does not own customer OAuth, Linear application credentials, browser
routes, multi-project scheduling, or a general workflow platform. Linear calls
go through Podium's authenticated proxy; the daemon never stores a direct
Linear token.

## Target surface

```text
conductor/
  __init__.py
  cli.py          # installed entrypoint and local process setup
  api.py          # retained local API surface
  models.py       # settings, instance, run, task, attempt, wait
  store.py        # one SQLite database and transactions
  service.py      # composition root and one bounded background tick
  podium.py       # HTTP report, command, dispatch, config, smoke calls
  linear.py       # proxy operations for parent, child, state, comment, wait
  workflow.py     # the only sequential state machine
  gate.py         # command checks and boolean gate input
  runtime.py      # Performer process, CODEX_HOME, logs, fencing
```

The old managed-run coordinator/driver/projection/store/artifact/verifier/join/
checkpoint graph is removed. The remaining service/runtime and Linear HTTP
owners exist only for the retained local API, enrollment, logs, labels, and
Podium Web behavior; they are not workflow authorities.

## Current implementation disposition

The existing code already contains semantics that the new design must preserve:

| Existing capability | Retain as | Remove only |
|---|---|---|
| `ManagedRunPlan` architecture decisions, risks, open questions, approval | `workflow.py` plan revisions | parallel/dependency fields |
| `conductor_managed_run_coordinator_human.py` | `workflow.py` approval/revision transitions | duplicate human-action mixins |
| `conductor_managed_run_gates.py` snapshots, rubric scores, manifests | `gate.py` and `store.py` evidence | branch/checkpoint coupling |
| `conductor_managed_run_verifier.py` artifact/hash verification | `gate.py` verifier | generic verifier wrappers |
| `conductor_managed_run_store_artifacts.py` | `store.py` artifact/evidence records | duplicate row/view mixins |
| Linear projection and managed-runs summary | `linear.py`/`api.py` report | projection helper fan-out |

The checkpoint domain is the explicit deletion: remove the `Checkpoint` plan
field, `conductor_managed_run_coordinator_checkpoints.py`, checkpoint workspace
and branch-join helpers, `managed_run_checkpoint_results`, and checkpoint-only
projection fields. Linear polling checkpoints in Podium are unrelated and stay.

## Canonical workflow

```text
planning -> awaiting_approval -> executing -> blocked | failed | done
todo -> in_progress -> in_review -> blocked | done
running -> waiting | succeeded | failed | stale
```

The service tick is bounded and idempotent:

1. Send a runtime report when due.
2. Lease and acknowledge at most one Podium control command.
3. Lease and acknowledge at most one parent dispatch.
4. Advance the local workflow once.
5. Sleep with bounded backoff and jitter.

For a new parent, Conductor obtains one ordered plan, validates it, creates one
real Linear sub-issue per task with an explicit parent relationship, and stores
the Linear ids. A plan revision is approved before it becomes the active
revision; risks, architecture decisions, open questions, acceptance-catalog
entries, manifests, and artifacts remain linked to that revision. It executes
only the first unfinished child. A child is not Done until all declared
verification commands pass and one read-only Codex gate returns `passed=true`
with its score, rubric, threshold, weights, provenance, and evidence. One failed
gate may trigger one rework attempt; the next failure blocks the child and
parent with a concrete next action. The parent becomes Done only after every
child is Done.

## Durable store baseline

The replacement local database contains only the tables needed to recover the
flow:

| Table | Purpose |
|---|---|
| `settings` | Bound project/repository and runtime configuration |
| `instance` | Conductor identity, lease/presence and current report metadata |
| `runs` | Parent issue, state, plan summary, current task and latest failure |
| `tasks` | Ordered child issue id, task contract, state, gate status, rework count |
| `attempts` | Fenced plan/execute/gate invocation and result metadata |
| `runtime_waits` | Codex/runtime approval wait and resume key |
| `plan_revisions` | Immutable plan versions, approval, policy revision, and metadata |
| `acceptance_catalog` | Per-task criteria, rubric, thresholds, and weights |
| `gate_evidence` | Command/Codex findings, scores, provenance, and artifact links |
| `artifacts` | Sanitized manifest and evidence artifact metadata |

Writes that advance a state, accept a result, or create a child are
transactional and idempotent. A restarted daemon reuses the same run and child
ids. A stale fencing token changes no current state.

## Linear projection baseline

`linear.py` owns only the concrete operations required by the flow: read the
parent, create/update ordered children, project plan revisions and approval,
set states, add concise plan/gate/error comments, link acceptance-catalog and
gate/evidence child issues, read the project label, and create/resume a
`[Human Action]` runtime-wait issue when Codex requires operator input. It
verifies `parent { id identifier }` explicitly and never infers hierarchy from
title or comments.

Dependency relations, branch/join metadata, checkpoint groups, integration
conflict children, arbitrary comment commands, and graph readiness are removed.
Plan revisions, approval, acceptance catalogs, gate/evidence issue trees, and
artifact provenance remain owned by this module.

## Runtime and failure baseline

`runtime.py` starts the installed Performer command, stages the isolated runtime
home, captures stdout/stderr, records heartbeats, and validates the exact
context/fence on result collection. All failures carry
`error_code`, `sanitized_reason`, `action_required`, `retryable`, and
`next_action` in SQLite, logs, Linear, and the Podium report. Logs are
single-line structured events with run/task/attempt/fence correlation.

## Migration and exit gate

1. Archive existing local Managed Run databases; do not silently reinterpret
   their expanded state machine as the new one.
2. Add restart, idempotency, child-parent, revision/approval, gate/rework,
   score/rubric/evidence, parent completion, runtime-wait, and stale-result tests.
3. Keep the compact `models.py`, `store.py`, `workflow.py`, `gate.py`, `runtime.py`,
   and `workflow_driver.py` as the only workflow owners.
4. Delete checkpoint/branch-join code and duplicate wrappers; retained
   revision, approval, catalog, rubric, manifest, artifact, and verifier
   semantics live in the compact owners.

The baseline is complete when one Conductor tick can be followed end-to-end in
`service.py`, every child is a real Linear sub-issue, the single gate is scored
and fenced with durable evidence, and no DAG/parallel/branch/join/checkpoint-
group concept is present in code or schema.
