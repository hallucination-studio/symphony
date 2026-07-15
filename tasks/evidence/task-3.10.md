# Task 3.10 evidence

- Private `conductor.create` accepts exactly project id + canonical existing repository directory.
- One SQLite transaction validates connected project and active project/repository/conductor uniqueness, then commits generation 1, desired running, observed pending, stable ids, and an isolated data-root key.
- Command/protocol output contains only safe ids and states; repository paths and credential sentinels are absent.
- Invalid input, unavailable projects, uniqueness conflicts, and injected SQLite failures leave no binding row.
- Focused verification: `71 passed` across create, binding, migration, catalog, Desktop protocol/snapshot, dispatch, and disconnect tests.
- Process start/session creation are intentionally deferred; real Linear/Codex execution remains Phase 7.
