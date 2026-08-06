# Root Workspace and Delivery

| Status | Owns | Does not own |
|---|---|---|
| target proposal | Root Reconcile Prepare, one Root workspace, role access, and structured terminal Delivery | Cycle decisions, merge, retries, cleanup, or Podium queue semantics |

## Prepare

`Prepare` is the first phase of the Root Reconcile role. It is not another
Agent role, Linear Issue, or Linear workflow status. Conductor launches the
phase and validates its structured result; it must not execute Git commands.

```text
Root Reconcile Prepare
  -> supplied preferred path: validate it or create a worktree and Root branch there
  -> no preferred path: adopt the invocation current directory and current branch
  -> return workspace_path, run_directory, root_branch
  -> Conductor persists the exact binding in Root State
```

| Rule | Required behavior |
|---|---|
| `WS-PREP-001` | when a preferred workspace is supplied, Root Reconcile uses that exact valid workspace or creates a worktree there |
| `WS-PREP-002` | failure at a supplied path is visible and must not silently fall back to another path |
| `WS-PREP-003` | without a supplied workspace, adopt the current directory and branch without switching, cleaning, or resetting |
| `WS-PREP-004` | keep the external run directory outside the workspace for private diagnostics |
| `WS-PREP-005` | Conductor validates and persists the returned binding but runs no worktree or branch command |
| `WS-PREP-006` | restart reuses the Root State binding and does not prepare a replacement |

Podium Desktop may persist a preferred `workspace_path` and create the external
`run_directory`, but it only reserves the workspace path. Root Reconcile owns
the actual worktree and branch creation. Every Cycle then reuses the prepared
workspace. There are no per-Cycle worktrees, snapshots, or patch stores.
Assignment records, process IDs, and the pending queue are Desktop memory only;
the stable allocation is the persisted Root ID, preferred path, and run directory.

## Role access

| Role and phase | Access | Constraint |
|---|---|---|
| Root Reconcile Prepare | workspace-write | prepare or adopt the binding only; do not implement the task |
| Root Reconcile Cycle decision | workspace-write process, audited-state authority | do not replace Audit judgment with self-inspection |
| Execute | workspace-write | implement only the frozen Cycle |
| Audit | read-only | inspect the full current workspace independently |
| Root Reconcile Delivery | workspace-write | create the best available structured Delivery |

Execute failed attempts still proceed to Audit; partial changes and residual effects
are independently inspected. Executor Markdown remains display-only and
never pre-judges the fresh read-only Audit.

Role-specific Agent credentials and provider configuration remain backend
launch configuration. Secrets are never placed in public contracts, prompts,
Root State, Linear descriptions, or diagnostic summaries.

## Delivery

Root Reconcile owns delivery after trusted Audit state supports completion and
the final Inbox check is empty. It should prefer installed Git and `gh`, but it
may return local files when remote delivery is unavailable or unnecessary.

```text
Delivery =
  | { kind: pull_request, url, branch }
  | { kind: branch, branch, remote? }
  | { kind: files, workspace_path, files[] }
```

| Rule | Required behavior |
|---|---|
| `WS-DELIVERY-001` | Root Reconcile executes any commit, push, or `gh` command; Conductor executes none |
| `WS-DELIVERY-002` | return exactly one closed, valid, locatable Delivery value |
| `WS-DELIVERY-003` | a files Delivery identifies the absolute workspace and at least one delivered relative file |
| `WS-DELIVERY-004` | Conductor persists Delivery and the visible `## Delivery` description section before Root `Done` |
| `WS-DELIVERY-005` | any valid Delivery kind permits `Done` when Root Reconcile judges the result deliverable |
| `WS-DELIVERY-006` | new Root input before projection cancels completion and returns to Reconcile |

The Root description renders Delivery mechanically from Root State. It is not
inferred from Markdown. Conductor does not override the selected delivery kind
or require a PR/remote branch when Root Reconcile returns files.

## Non-goals

- no Delivery Issue, finalizer, retry scheduler, receipt, or convergence protocol;
- no automatic merge, rebase, rollback, reset, cleanup, or workspace deletion;
- no Conductor Git/worktree/commit/push/PR execution;
- no second Audit dedicated only to delivery;
- no hidden compatibility fields for retired PR/pushed-branch state.
