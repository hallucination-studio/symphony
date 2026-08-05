# Root Workspace and Pull Request

| Status | Owns | Does not own |
|---|---|---|
| target proposal | one Root-owned workspace, role access, and one terminal PR command sequence | Cycle decisions, delivery subsystem, merge, or provider reconciliation |

## Root workspace

The caller supplies exactly one isolated Git workspace and branch already bound
to the Root. Every Cycle for that Root uses the same workspace. There are no
per-Cycle worktrees, patch stores, repository snapshots, or workspace versions.

```text
manual V1 caller or future Podium
  -> allocate Root branch, workspace, and external run directory
  -> start Conductor with those exact paths
  -> Execute/Audit sessions use that workspace; Reconcile has no workspace access
  -> successful Root completion creates one PR
```

| Rule | Boundary | Required behavior |
|---|---|---|
| `WS-ROOT-001` | startup | validate the supplied workspace is an isolated Git workspace with a usable branch and remote |
| `WS-ROOT-002` | evidence | validate the supplied run directory is writable, outside the workspace, and bound to the same Root |
| `WS-ROOT-003` | lifetime | require both supplied paths to stay bound to one Root for the complete run |
| `WS-ROOT-004` | failure | preserve the workspace for inspection; do not reset, clean, rollback, or delete it |
| `WS-ROOT-005` | ownership | allocation, claiming, cleanup, and deletion belong to the caller or future Podium, never Conductor |

Root State records the workspace, run directory, and branch. On a later process
start, Conductor requires the supplied paths to match those exact values. It
never creates or adopts replacements. If either path is missing, invalid, or
mismatched, the Root becomes `NeedsHuman` and no Agent starts.

## Role access

| Rule | Role | Access | Constraint |
|---|---|---|---|
| `WS-ACCESS-001` | Root Reconcile | none | reason only from Root-owned prompt inputs; no workspace mount or tools |
| `WS-ACCESS-002` | Execute | workspace-write | mutate only the Root workspace and run required commands |
| `WS-ACCESS-003` | Audit | read-only | inspect current files, status, diff, and run non-mutating checks |
| `WS-ACCESS-004` | all Agent roles | no secrets by default | deny environment files, credentials, key stores, and delivery credentials |

One active Cycle prevents concurrent harness writes. Git and PR credentials are
available only to the terminal delivery command, never to Agent sessions.

## Execute and Audit handoff

```mermaid
%% source-rules: WS-HANDOFF-001 WS-HANDOFF-002 WS-HANDOFF-003 WF-TR-004 WF-TR-005
sequenceDiagram
  participant E as Execute session
  participant W as Root workspace
  participant C as Cycle Runner
  participant A as Fresh Audit session
  E->>W: mutate files and run commands
  E-->>C: mechanical process facts; model output discarded
  C->>A: frozen Cycle contract, process facts, workspace path
  A->>W: inspect current state and run read-only checks
  A-->>C: independent Audit Result
```

| Rule | Boundary | Required behavior |
|---|---|---|
| `WS-HANDOFF-001` | after Execute | leave the workspace exactly as Execute produced it |
| `WS-HANDOFF-002` | before Audit | start a new session with no Execute transcript |
| `WS-HANDOFF-003` | Audit evidence | inspect current workspace state, not a claimed or reconstructed snapshot |
| `WS-HANDOFF-004` | Execute failed | Audit still inspects partial changes and residual effects |
| `WS-HANDOFF-005` | Cycle terminal | leave repair, cleanup, or progress to the next Root Reconcile |
| `WS-HANDOFF-006` | every Audit | inspect the complete workspace diff for out-of-bound changes, not only files named by Execute |

Execute output is deliberately absent from the handoff. It is an untrusted
self-report and cannot reduce Audit's obligation to inspect the frozen contract
and complete real diff. Only mechanical process facts cross the boundary so
Audit knows whether execution was interrupted without treating that fact as a
semantic conclusion.

## Terminal PR publication

Root Reconcile does not set Root `Done`. A `complete` recommendation enters the
following fixed sequence:

```text
fetch Root comments once more
  -> new pending input? return to Root Reconcile
  -> active Cycle? fail closed
  -> no workspace changes? NeedsHuman, stop
  -> set Root State phase to publishing
  -> git add --all
  -> git commit
  -> git push --set-upstream
  -> create pull request
  -> publish PR URL on Root
  -> set Root Done
```

| Rule | Step | Success condition | Failure behavior |
|---|---|---|---|
| `WS-PR-001` | final Inbox check | no new eligible Root comments | do not publish; reconcile again |
| `WS-PR-002` | validate diff | at least one workspace change | leave Root open as `NeedsHuman` |
| `WS-PR-003` | publish guard | Root State phase is `publishing` before external commands | interrupted publication becomes `NeedsHuman`; never attempt again automatically |
| `WS-PR-004` | commit | one ordinary commit is created on the Root branch | stop and retain workspace |
| `WS-PR-005` | push | Root branch is pushed to its configured remote | stop and retain workspace |
| `WS-PR-006` | create PR | provider returns one PR URL | stop and retain workspace |
| `WS-PR-007` | complete Root | PR URL is recorded in Root State | only then set Root `Done` |

The implementation may use the installed Git and provider CLI. It records the
commands, bounded output, branch, and PR URL under the supplied run directory, but
does not model commit identity or use a hash as workflow authority. The local
evidence directory is outside the Root workspace, so `git add --all` cannot
include prompts, trajectories, or command logs.

## Explicit non-goals

- no delivery subsystem, finalizer, convergence protocol, receipt, or delivery Issue;
- no retry scheduler, idempotency database, unknown-outcome recovery, or
  adoption of an existing branch or PR;
- no automatic merge, rebase, conflict repair, rollback, reset, cleanup, or
  workspace deletion;
- no Agent-session resume or reconstruction; restart only reuses the workspace
  located by Root State and abandons unfinished child Issues;
- no repository snapshot, revision equality, commit-identity authority, or digest protocol.
