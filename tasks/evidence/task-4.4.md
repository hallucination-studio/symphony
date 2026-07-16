# Task 4.4 evidence

- Start commit: `a754977` (`feat: configure Conductors over private IPC`).
- Scope ledger: `tasks/scope-ledgers/task-4.4.md`; all Task file aliases resolve
  to the four repo-relative paths listed there and
  `assumptions_requiring_approval` is empty.
- TDD baseline: focused collection failed with
  `ImportError: cannot import name 'LocalRuntimeIdentity'` before production
  code existed.
- The Conductor client validates the inherited handshake and every typed DTO
  against exact conductor, instance, project, binding, and generation identity;
  stale transport closes and logs a correlated sanitized failure.
- Configure and dispatch lease are received as performer-api DTOs; runtime
  report, dispatch ACK, and drain ACK are sent as performer-api DTOs without a
  Podium import or token/URL/header constructor input.
- Drain stops new-turn admission before polling workflow.db, waits while a
  running attempt still requires result persistence, then sends one exact ACK.
  Duplicate requests are idempotent; deadline and database failures return
  stable failed ACKs and remain closed to new turns.
- Focused verification after implementation: `74 passed`; after review fixes,
  the expanded focused command exited `0`, and the Task-owned file reports
  `9 passed`.
- `code-simplification`: normalized imports; the mandatory pass after review
  fixes recorded `simple_code_no_change`.
- `code-review-and-quality` found two `IN_SCOPE_BLOCKER` groups. Malformed IPC
  rejection lacked correlated operator logging, and workflow.db read failure
  lacked a stable failed ACK; both were fixed. The second review also rejected
  broad exception swallowing and secret-like identity log material. Final
  review found no remaining blocker.
- Finding adjudication: all findings trace to Task 4.4 fail-closed acceptance
  and repository error-visibility/log-sanitization invariants and were fixed as
  `IN_SCOPE_BLOCKER`. No `IN_SCOPE_OPTIONAL`,
  `OUT_OF_SCOPE_REVIEW_SUGGESTION`, or `INVALID_FINDING` remained.
- First full run had four unrelated fake Performer subprocess timeouts; all
  four exact nodes passed immediately on rerun. Second full run had one
  unrelated legacy enrollment subprocess failure; its exact node passed on
  rerun. No production changes were made for these transient legacy failures.
- Final canonical verification: `871 passed, 1 skipped` via `make test`.
- Forbidden scan found no token, bearer, URL/listener, OAuth secret,
  PostgreSQL, or asyncpg vocabulary in the new production IPC client; the
  identity constructor block has no token/URL/header input. `git diff --check`
  passed.
- Residual risk: active tick ordering and enforcement of new-turn admission are
  intentionally deferred to Task 4.5; legacy HTTP settings remain until the
  ordered Phase 8 deletion tasks.
