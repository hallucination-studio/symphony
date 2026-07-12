# Module baseline: `conductor`

Status: implemented code baseline, 2026-07-12. The local workflow is covered
by fakes and SQLite; a real Linear/Codex flow remains unverified here.

## Responsibility

Conductor is the customer-side daemon for one bound Linear project and one
repository. It leases Podium dispatches over HTTP, keeps a durable sequential
workflow, launches Performer, projects ordered Linear Sub Issues, runs command
checks plus one Codex Gate, and reports a sanitized view back to Podium.

It is the only local process manager for Performer. It does not own customer
OAuth, browser routes, a multi-project scheduler, or direct Linear tokens;
Linear operations travel through Podium's authenticated proxy.

## Current ownership

The code has more than the eventual compact target, but ownership is explicit:

| Owner | Responsibility |
|---|---|
| `models.py`, `store.py` | SQLite settings, instances, runs, tasks, attempts, waits, revisions, evidence rows, and all durable state transitions/fencing |
| `workflow_driver.py` | One bounded plan/execute/gate progression and Linear projection |
| `runtime.py` | Request/result files, isolated `CODEX_HOME`, process logs, result fencing |
| `gate.py` | Declared verification commands and the single Codex Gate combination |
| `linear.py` | Podium proxy operations for issue reads, children, comments, states, and read-only project-label lookup for smoke validation |
| `conductor_podium_sync.py` | Runtime report, command polling, dispatch lease, and smoke handling |
| `conductor_api.py`, `conductor_service.py` | Local HTTP API and composition/background tick |

`conductor_service.py` directly owns the instance, workspace, log, and
runtime-view operations. `conductor_service_helpers.py` remains only for
functions shared by the service and sync owner; protocol helpers remain local
to their concrete boundary.

## Canonical workflow

```text
planning -> awaiting_approval -> executing -> blocked | failed | done
todo -> in_progress -> in_review -> blocked | done
running -> waiting | succeeded | failed | stale
```

For one parent, Conductor validates one ordered plan, creates one Linear child
per task with an explicit parent relation, and executes only the first
unfinished task. A child becomes Done only after every declared verification
command passes and the read-only Codex Gate passes. A failed gate returns the
task to one rework; a second failure blocks the task and parent. The parent is
Done only after all children are Done.

Plan revisions, approvals, risks, architecture decisions, open questions,
acceptance catalogs, score/rubric/provenance, manifest references, artifacts,
and gate evidence remain in the durable model. They are not a dependency graph
or second scheduler.

## Durable state and projection

The fresh local `workflow.db` contains settings, instances, runs, tasks,
attempts, runtime waits, plan revisions, acceptance catalogs, gate evidence,
and artifact records. A restart reuses the same run and Linear child ids; a
stale fence cannot advance state.

Current Linear projection creates task Sub Issues and runtime-wait
`[Human Action]` children, projects state/comments, and verifies explicit
`parent { id identifier }`. It does **not** create a separate catalog,
gate-evidence, or artifact child-issue tree. Current Podium reports expose run
and work-item state; detailed evidence is retained locally rather than claimed
to be rendered by Web.

The outbound managed-run report is a bounded current-binding snapshot: it
prioritizes nonterminal runs, then recent terminal history, and reports the
total number of active runs so Podium can keep installation cutover fail-closed
when history is compacted.

## Runtime and error rules

`runtime.py` stages isolated Codex homes, captures Performer stdout/stderr, and
accepts only the expected fenced result. Errors are sanitized and appended to
the relevant run/task/log/Linear surfaces where implemented. Do not claim that
every current SQLite record has the same five failure fields: the run view's
primary durable summary is `latest_reason`.

## Hard-cut rules

- Start a fresh `workflow.db`; never read or migrate old local runtime data.
- A successful project unbind or rebind atomically replaces the binding and
  clears old runs, tasks, attempts, revisions, waits, catalogs, evidence, and
  artifacts before the new binding can report work.
- Do not add DAG, parallel, branch/join, checkpoint-group, integration-queue,
  cross-model, or second acceptance-scheduler behavior.
- Preserve one automatic gate rework, runtime waits controlled by Linear state,
  plan approval, fences, durable logs, and visible sanitized failure reasons.
