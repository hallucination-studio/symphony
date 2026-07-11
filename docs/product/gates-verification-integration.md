# Gates and verification

Conductor owns one acceptance gate for each Linear Sub Issue. The gate is not
a second scheduler and it is not a cross-model review.

## Gate input

The gate receives the task contract, actual changed files, acceptance criteria,
declared verification commands, and the execute result. Conductor runs every
command exactly once and stores its exit code and sanitized tail. It then sends
that evidence to one read-only Codex Gate turn.

## Pass rule

```text
passed = all verification commands passed
         and Codex Gate returned passed=true
         and score >= threshold
```

The Codex result keeps the retained score, rubric rows, threshold, weights,
provenance, findings, acceptance-catalog id, manifest references, and artifact
references. These are evidence fields on the gate, not a separate verifier
framework. A gate turn that changes files fails closed.

## Rework and failure

The first failed gate returns the task to `in_progress` for one automatic
execute rework. The next failure sets the task and run to `blocked`, writes a
concrete `gate_failed` reason and next action, comments the child issue, and
appears in the Podium managed-runs report. No child or parent can become Done
without a passing gate.

## Evidence

The durable `gate_evidence` row links the task, gate attempt, command results,
Codex result, rubric, provenance, manifest, and artifact references. Linear
receives a concise comment and the task state; Podium receives the sanitized
summary. Raw credentials and unbounded command output never enter either
surface.

There are no checkpoint groups, branch joins, dependency graphs, integration
queues, or hidden acceptance runners. Linear polling checkpoints remain a
Podium cursor concern and are unrelated to this gate.
