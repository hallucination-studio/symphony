# Checkpoint 4B evidence

- Start commit: `b9a3398` (`refactor: switch Conductor sync to private IPC`).
- Scope ledger: `tasks/scope-ledgers/checkpoint-4b.md`;
  `assumptions_requiring_approval` is empty.
- Added one cross-role integration test using a real inherited socketpair, a
  Podium `LocalRuntimeServer`/session registry/command dispatcher backed by
  `podium.db`, and a Conductor `LocalRuntimeClient`/service backed by isolated
  `workflow.db`.
- Observed one exact Configure from the approved Podium binding, one matching
  ready report from Conductor, one Podium lease, one accepted ACK, and one
  durable Conductor run for `issue-checkpoint` with dispatch fencing token 11.
- No shared token, bearer/header, public runtime listener, or cross-package
  production import was added; the integration composes the committed role
  boundaries only through performer-api DTOs and the inherited channel.
- `code-simplification`: the checkpoint adds one direct integration path and
  reuses production builders/transports; it introduces no fixture framework or
  helper abstraction.
- `code-review-and-quality`: verified exact identity/generation context, wire
  ordering, durable-state-before-ACK, isolated stores, cleanup, and package
  boundaries. No blocker remained.
- Focused verification: `26 passed` across Checkpoint 4B, Podium commands,
  Conductor private sync/bootstrap, and package boundaries.
- Final canonical verification: `902 passed, 1 skipped` via `make test`.
- `git diff --check` passed. The one skip is the existing platform-dependent
  Desktop bundle check and is unrelated to this checkpoint.
- Acceptance score: `4/4` for Checkpoint 4B's local private IPC closure. Real
  Linear/Codex behavior is not part of this transport checkpoint.
