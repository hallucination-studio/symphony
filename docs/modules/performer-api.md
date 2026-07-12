# Module baseline: `performer-api`

Status: implemented code baseline, 2026-07-12.

## Responsibility

`performer-api` is the dependency-free shared wire-contract package. It carries
only the JSON models that must cross the Performer/Conductor boundary: plans,
tasks, fenced turn context, execute/gate results, and runtime waits. It does
not execute work, persist state, call Linear, make HTTP requests, or select a
Codex backend.

```text
performer-api <- performer
performer-api <- conductor
performer-api <- podium (only if a shared contract is needed)
```

## Current surface

```text
performer_api/
  __init__.py
  labels.py         # Canonical Podium-owned project-label formatter/validator
  workflow.py       # Task, Plan, AcceptanceCatalog, PlanRevision
  turns.py          # TurnContext, RuntimeWait, ExecuteResult, GateResult
  validation.py     # plan and context validation
```

There is no `runtime.py`, `TurnRequest`, or `TurnResult` module/type in this
package. Old Managed Run compatibility exports are intentionally absent.

## Contracts

- A `Plan` contains ordered `Task` values. Each task declares an objective,
  acceptance criteria, verification commands, and file scope. The order is the
  execution order; task contracts contain no dependency, parallel, or
  checkpoint fields.
- The shared project-label contract formats and validates only
  `symphony:conductor/<Name>-<public-id>` labels. Podium owns their lifecycle;
  Conductor uses the contract only to validate a smoke command.
- A `Plan` may retain risks, architecture decisions, open questions, an
  acceptance catalog, and `approval_required`. `PlanRevision` adds version,
  status, policy revision, approval id, and manifest references.
- `TurnContext` is the fencing boundary: run id, task id, attempt id, fencing
  token, and `plan|execute|gate`. Performer echoes it and Conductor rejects a
  stale or mismatched result.
- `ExecuteResult` carries status, summary, changed files, criterion evidence,
  and an optional blocked reason.
- `GateResult` carries `passed`, score/threshold/rubric/provenance, findings,
  and artifact references. It represents one Codex evaluator, never a
  cross-model review or scheduler.
- `RuntimeWait` carries only a wait kind and sanitized reason. Resume identity
  belongs to Conductor's durable wait record, not this wire model.

## Boundary rules

- Validate untrusted JSON at the Performer/Conductor boundary; keep internal
  calls typed rather than repeating defensive parsing.
- Do not place SDK objects, secrets, credentials, or local runtime paths in a
  shared contract.
- Keep unknown turn kinds and malformed fencing contexts deterministic and
  reject them with a stable reason.

## Explicit removals

The package has no capacity scheduler, dependency policy, checkpoint group,
parallel executor, backend registry, or compatibility aliases. Durable plan
and acceptance data remain contracts rather than a workflow engine.
