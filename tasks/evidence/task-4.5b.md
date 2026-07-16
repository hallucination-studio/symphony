# Task 4.5b evidence

- Start commit: `20474fa` (`fix: complete the private Configure contract`).
- Scope ledger: `tasks/scope-ledgers/task-4.5b.md`;
  `assumptions_requiring_approval` is empty.
- TDD baseline: the initial private Configure tests failed because Conductor
  had no `apply_private_configure`; the later durable identity regression
  failed with `already_applied` for a mismatched `instance_id`.
- Conductor now consumes the closed `ConfigureCommand`, maps only its exact
  fields into the existing structured profile validation path, and persists
  the private instance id, canonical repository, binding/profile generation,
  policy hashes, project/app metadata, and policy revision in `workflow.db`.
- Exact duplicates remain idempotent across service restart. Stale generation,
  policy hash drift, repository drift, project mismatch, and instance mismatch
  fail closed without mutating the durable binding.
- Rejections produce bounded sanitized failure state and a correlated instance
  log event for the later private report path.
- `code-simplification`: retained the existing canonical project/profile apply
  path and added only an internal optional instance identity; no parallel
  validator or compatibility shape was introduced.
- `code-review-and-quality`: found and fixed the instance-context mismatch;
  no remaining in-scope blocker was identified across correctness,
  architecture, security, readability, or performance.
- Focused verification: `83 passed` across private Configure, legacy project
  sync, policy projection, local runtime contract/commands, and package
  boundaries.
- Final canonical verification: `886 passed, 1 skipped` via `make test`.
- The private Configure method scan found no HTTP URL, bearer/header/token,
  cookie/API-key, Podium URL, or provider config/SDK/session input. Package
  boundary scan and tests passed; `git diff --check` passed.
- Acceptance score: `4/4` for this local application slice. Active inherited
  IPC bootstrap and tick routing are intentionally deferred to Tasks 4.5c and
  4.5d, so no real Linear/Codex run applies to this task.
