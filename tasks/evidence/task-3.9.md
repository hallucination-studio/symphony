# Task 3.9 evidence

- `linear.projects` returns only `id`, `name`, `slug`, and active-binding-derived `bound`.
- SQLite migration 5 removes the standalone `selected` column; the selection mutation is absent from the local repository and command surface.
- Reopen tests preserve project metadata and active bindings without a second setup state.
- Discovery refuses to erase a project used by an active binding.
- Focused verification: `56 passed` across catalog, discovery, migrations, disconnect, snapshot, and Desktop command tests.
- Real Linear execution is intentionally deferred to Phase 7.
