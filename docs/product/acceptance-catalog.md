# Acceptance catalog

Acceptance is defined on each workflow plan and task. A task records its
verification commands and the read-only Codex Gate's rubric, score, threshold,
provenance, findings, and artifact references.

The only acceptance authority is:

1. every declared verification command exits successfully; and
2. the single Codex Gate returns `passed=true` and meets the recorded threshold.

One failed gate may re-enter the same Sub Issue for one automatic rework. A
second failure blocks the task and the parent run. There is no cross-model
reviewer, independent acceptance catalog runner, or second scheduler.
