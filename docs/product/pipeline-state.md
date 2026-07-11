# Managed Run State

## Authority

Conductor's durable `workflow.db` store is the execution source of truth.
Linear is the operator projection and human-event surface. Podium supplies
dispatches, runtime configuration, and reporting transport, but Conductor owns
local run state, plan revisions, Sub Issue state, gate evidence, waits, and
convergence.

Every delegated Linear parent issue maps to one managed run. The run is resumed
by `run_id`, parent issue id, or issue identifier; duplicate dispatches reuse
the existing run instead of creating a second execution path.

## Durable Objects

The store owns these objects:

- `runs`: parent issue mapping, instance id, run state, active work item,
  backend session id, latest sanitized reason, timestamps, and plan version.
- `plan_revisions`: immutable plan payloads with approval and policy revisions.
- `tasks`: ordered Sub Issue lifecycle, latest execute result, and gate status.
- `attempts`: fenced plan, execute, and gate turns.
- `runtime_waits`: visible approval/permission/tool-input waits.
- `gate_evidence` and `artifacts`: command evidence, rubric/provenance, and
  artifact references.

## Run State

Managed runs use these durable states:

```text
planning
awaiting_approval
executing
blocked
failed
done
```

`awaiting_approval` means a planned human approval gate is blocking execution.
`blocked` always carries `latest_reason` with a sanitized, operator-visible
cause. `done` is allowed only after every ordered task passes its verification
commands and the single Codex Gate, with the parent Linear summary recorded.

## Work-Item State

Work items use the normal Linear lifecycle:

```text
todo
in_progress
in_review
done
blocked
cancelled
```

Conductor selects exactly one `todo` item at a time. A task can start only when
its file scope is present and the runtime profile is available.

`blocked` work items stay out of Done and expose their `gate_status` in durable
state and Linear projection.

## Plan Versions

The first turn produces a structured plan and must not modify files. Conductor
validates scope, verification commands, acceptance criteria, and retained
rubric metadata before saving plan revision `1`.

Accepted plan versions are immutable. If execution needs a new file scope,
dependency, acceptance criterion, or human decision, the backend requests a plan
revision. Conductor saves the new plan version only after approval, resets the
affected item to Todo, and marks removed work items `cancelled`.

## Verification And Gate

Execution results are claims, not verdicts. Conductor verifies:

- changed files are declared and planned;
- undeclared changes are absent;
- every declared verification command passes;
- the read-only Codex Gate returns `passed=true` and meets its threshold.

The first Gate failure allows one automatic rework. A second failure blocks the
task and parent with a concrete reason.

## Recovery

A restarted Conductor resumes from durable state:

- Done tasks remain terminal;
- gate evidence and waits remain authoritative;
- the latest Codex thread id is reused when available;
- the next non-terminal ordered task is selected;
- blocked reasons remain visible until a real operator action or approved plan
  revision resolves them.

Logs are evidence, not state. Every terminal or human-action-causing failure
must be present in durable state, operator logs, and the relevant Linear
projection.
