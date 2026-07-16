# Task 4.5a evidence

- Start commit: `bbc0a34` (`docs: split the private sync cutover tasks`).
- Scope ledger: `tasks/scope-ledgers/task-4.5a.md`;
  `assumptions_requiring_approval` is empty.
- TDD baseline: `7 failed, 26 passed`; every failure showed the old Configure
  constructor/old lone-profile-id shape was still active.
- Configure now carries exact context, canonical repository path, bounded
  project slug/name, app user id, policy revision, and one closed
  `PerformerProfileConfig`.
- Profile binding/config generation must match context, both provenance kinds
  must be `codex`, and secret-like identity/metadata values fail closed.
- The Podium builder and both existing direct consumer test modules moved in
  the same commit; no compatibility constructor or second protocol version was
  introduced. The Task file budget was corrected accordingly, with module
  documentation moved to Task 4.5b.
- Focused verification after implementation and after simplification:
  `172 passed` across local runtime contract, Podium command builder, Conductor
  IPC transport, runtime policy, and package-boundary tests.
- `code-simplification`: consolidated repeated identifier + secret-material
  checks into one module-private helper; verification remained green.
- `code-review-and-quality`: no `IN_SCOPE_BLOCKER` remained. Exact fields,
  transition/cross-field validation, payload bounds, secret rejection, import
  boundaries, and one-version behavior all trace to Task 4.5a acceptance.
- Finding adjudication: no `IN_SCOPE_OPTIONAL`,
  `OUT_OF_SCOPE_REVIEW_SUGGESTION`, or `INVALID_FINDING` required changes.
- Final canonical verification: `880 passed, 1 skipped` via `make test`.
- Old-shape scan found only the intentional negative-test fixture; forbidden
  token/header/URL/provider-session/second-version scan found no production
  matches. `git diff --check` passed.
- Residual risk: Conductor durable Configure application and module docs are
  intentionally deferred to Task 4.5b.
