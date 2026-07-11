# Sequential workflow

The only managed workflow is:

```text
delegated Linear parent
  -> one Codex plan
  -> approval when requested
  -> ordered Linear Sub Issues
  -> execute first unfinished child
  -> verification commands
  -> one read-only Codex Gate
  -> child Done, or one rework then Blocked
  -> parent Done after every child is Done
```

Conductor persists the run, immutable plan revisions, tasks, fenced attempts,
runtime waits, acceptance-catalog data, gate evidence, and artifact references
in one SQLite database. Repeated polls and restarts reuse the parent run and
existing child identifiers. A stale attempt or fencing token cannot mutate the
current task.

The gate passes only when every declared command exits successfully and the
single Codex Gate returns `passed=true` with `score >= threshold`. The score,
rubric, weights, provenance, findings, and artifacts are evidence fields, not
another scheduler. A failed gate gets one automatic execute rework; the next
failure blocks the child and parent with a concrete sanitized reason.

Codex approval, permission, or tool-input waits are durable runtime waits. The
Conductor creates one `[Human Action]` Linear child and resumes the same task
with a fresh fence when that child is reopened. Local stdout alone is never the
operator surface for a wait or failure.
