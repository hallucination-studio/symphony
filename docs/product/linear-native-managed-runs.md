# Linear-native managed runs

One delegated Linear parent issue maps to one durable Conductor run. The run
has one ordered plan and one real Linear Sub Issue for each task.

## Product flow

```text
parent dispatch -> plan turn -> optional approval -> ordered Sub Issues
  -> execute one child -> verification commands -> read-only Codex Gate
  -> child Done, or one rework then Blocked
  -> next child -> parent Done after all children pass
```

Plan order is execution order. Tasks have an id, title, objective, acceptance
criteria, verification commands, and declared file scope. They do not have
dependency edges, parallel groups, branches, joins, or checkpoint fields.

Plan revisions are immutable records. A revision retains its reason, approval
state, policy revision, risks, architecture decisions, open questions,
acceptance-catalog link, manifest references, and artifact references. Only the
approved active revision can create or advance Sub Issues; superseded revisions
remain readable for provenance.

## Durable state

Conductor's `workflow.db` stores runs, tasks, fenced attempts, runtime waits,
plan revisions, acceptance-catalog rows, gate evidence, and artifacts. Repeated
polls and restarts reuse the parent run and existing child ids. A stale attempt
or fencing token changes no current state.

Runtime approval, permission, or tool-input waits set the current attempt to
`waiting`, block the exact task, and create one `[Human Action]` child. Reopening
that child resumes the task under a fresh fence.

## Linear projection

The parent description contains the plan summary. Each Sub Issue contains its
objective, criteria, commands, file scope, current state, and latest gate
summary. Conductor owns terminal state transitions and comments a sanitized
failure reason plus next action. The parent becomes Done only after every
planned Sub Issue is Done.

Linear remains the operator surface and collaboration record; SQLite remains
the workflow source of truth. Podium continues to own OAuth, project polling,
delegation epochs, dispatch routing, bindings, labels, and the proxy.
