# Module baseline: `performer-api`

Status: implemented baseline, 2026-07-12.

## Responsibility

`performer-api` is the dependency-free wire-contract package shared by
Performer, Conductor, and Podium where a shared type is unavoidable. It defines
the JSON shapes for one workflow plan, one turn, one result, and one runtime
wait. It does not execute work, access a database, call Linear, make HTTP
requests, or select a backend.

The package remains the bottom of the import graph:

```text
performer-api <- performer
performer-api <- conductor
performer-api <- podium (only where a wire contract is needed)
```

`performer-api` must not import any of the other three packages.

## Target surface

```text
performer_api/
  __init__.py
  workflow.py       # Plan, Task
  turns.py          # TurnContext, TurnRequest, TurnResult, RuntimeWait
  runtime.py         # compact versioned Codex runtime policy
  validation.py     # plan and context boundary validation
```

The old `managed_runs*` module family is removed rather than re-exported. This
is a hard break; no aliases for old names, states, or payloads are retained.

## Canonical contracts

### Plan

```json
{
  "summary": "string",
  "tasks": [
    {
      "id": "task-1",
      "title": "string",
      "objective": "string",
      "acceptance_criteria": ["string"],
      "verification_commands": ["string"],
      "files_likely_touched": ["path"]
    }
  ]
}
```

Validation requires 1–10 ordered tasks, unique ids, non-empty title and
objective, 1–5 acceptance criteria, at least one verification command, and a
non-empty file scope. Order is execution order. Task contracts have no
dependency, parallel, or checkpoint-group fields. The enclosing plan revision
may carry approval state, risks, architecture decisions, open questions, an
acceptance-catalog reference, and manifest/artifact references.

### Turn context

```json
{
  "run_id": "string",
  "task_id": "string-or-empty-for-plan",
  "attempt_id": "string",
  "fencing_token": 1,
  "turn_kind": "plan|execute|gate"
}
```

The attempt id is the lease identity. The fencing token is the only freshness
token. Performer echoes the exact context; Conductor rejects missing, stale, or
mismatched results before changing state.

### Results

Execute results are `ready_for_gate`, `blocked`, or `failed`, with a summary,
changed files, criterion evidence, and an optional blocked reason. Gate results
are boolean: `passed`, a score, threshold, rubric rows, provenance, a summary,
and criterion evidence. Runtime waits carry a sanitized reason, wait kind, and
resume key. All result models carry the correlation ids needed for logs and
durable state. The gate result is produced by one Codex evaluator; it does not
model cross-model review or a second scheduler.

## Explicit removals

Delete capacity schedulers, dependency/parallelization policy, checkpoint
groups, compatibility enums, and generic result aliases. Retain only the
versioned policy and Codex staging data needed to run turns. Retain durable plan/policy versions,
revisions, approval, rubric, architecture-decision, risk, open-question,
manifest, artifact, catalog, and provenance fields. They are data contracts,
not a generic workflow engine.

## Boundary rules

- Parse and validate external JSON at the Performer/Conductor boundary.
- Keep internal consumers typed; do not add repeated defensive validation in
  every caller.
- Reject unknown turn kinds and malformed result context deterministically.
- Do not put secrets, tokens, cookies, raw profile values, or SDK objects in a
  shared model.
- Use stable machine-readable error codes; callers add the sanitized operator
  text and next action.

## Migration and exit gate

1. Write contract tests for serialization, validation, exact context echo, and
   stale fence rejection.
2. Switch Performer and Conductor imports to the four target modules.
3. Switch Podium/Web report typing only where the retained response requires it.
4. Delete every `managed_runs*` file and old export; verify no import or payload
   string remains.

The module baseline is complete when the target package has at most five files,
the import-boundary test sees only the four package roles, and every remaining
field is consumed by at least one target owner.
