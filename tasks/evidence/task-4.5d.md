# Task 4.5d evidence

- Start commit: `20e829e` (`feat: bootstrap Conductor from inherited IPC`).
- Plan correction commit: `3f5445e` (`docs: correct the private sync cutover
  files`) added the Task 4.5c CLI owner and WorkflowDriver admission boundary to
  the authorized file list before production work.
- Scope ledger: `tasks/scope-ledgers/task-4.5d.md`;
  `assumptions_requiring_approval` is empty.
- TDD baseline: `4 failed` because Conductor had no `private_sync_once` active
  path. Later targeted tests exposed stale Configure correlation in lease
  failure logs and the need to preserve a failure through the next report.
- The active private tick now reads one closed Configure or drain command. A
  Configure is durably applied before a ready/degraded report; a matching lease
  is then durably attached to the workflow run before an ACK is sent.
- Real socketpair tests observed the exact wire order
  Configure -> report -> lease -> durable run -> ACK. A forced workflow.db
  write exception emitted no ACK, exposed only
  `private_dispatch_persist_failed`, and appeared in the next degraded report
  before the same channel recovered.
- Restart/re-lease verification applied the same dispatch/lease/fencing token
  through a new Conductor service and channel without creating a duplicate run.
  Stale/conflicting fencing data fails closed before ACK.
- Drain closes private admission before waiting for active result persistence;
  `WorkflowDriver.drive_once` returned zero work while closed, and only the
  drain ACK was emitted after the active result reached workflow.db.
- Private CLI tick waiting races SIGINT/SIGTERM against socket receive, closes
  the channel to unblock the worker, and retains the Task 4.5c subprocess proof
  of exit code 0 plus peer EOF with no orphan handle.
- The legacy Conductor HTTP API server no longer starts its old Podium polling
  task. Legacy live/command/report/dispatch helper methods remain inactive for
  the ordered deletion comparison.
- Missing/closed private transport records bounded in-memory failure state and
  a structured operator warning. Lease failures include validated conductor,
  instance, project, binding, correlation, dispatch, lease, fencing, and issue
  identifiers in finding/log surfaces without raw exceptions or paths.
- `code-simplification`: transport receive/send sequencing moved into the
  existing `LocalRuntimeClient`; durable binding/lease policy remains in the
  existing Conductor sync owner. Shared signal and failure-log paths were
  reused, and dead legacy poll-task state was removed.
- `code-review-and-quality`: fixed no-ACK persistence behavior, next-report
  failure retention, restart idempotency, lease correlation, SIGTERM receive
  wakeup, no-instance operator logging, and explicit private handler types. No
  remaining in-scope correctness, architecture, security, readability, or
  performance blocker was identified.
- Focused verification: `74 passed` across private sync, bootstrap, IPC,
  Configure, legacy comparison helpers, WorkflowDriver, and package boundaries.
  The final driver-focused regression was `54 passed`.
- Final canonical verification: `901 passed, 1 skipped` via `make test` after
  all production changes.
- Active private branch scans found no HTTP URL, bearer/header/token,
  credential, legacy live/command/report/dispatch call, listener, or
  `asyncio.start_server`; API start has no `_poll_podium_dispatches` call.
  Package-boundary tests and `git diff --check` passed.
- Acceptance score: `4/4` for the local private IPC cutover. Desktop process
  reconciliation is Task 4.6 and no real Linear/Codex run applies to this local
  transport/state slice.
