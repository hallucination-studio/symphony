# Task 4.1 evidence

- Added closed configure, drain request/ACK, dispatch lease/ACK, runtime report,
  gateway request/response, and canonical `performer_event` contracts.
- Every command/report context carries the approved runtime, project, binding,
  generation, and correlation identities; dispatch contracts also carry lease
  and fencing identities.
- Preserved the Task 1.4 `dispatch` envelope discriminator while adding the
  typed dispatch lease/ACK messages.
- `configure` contains no provider selector. The only provider field is the
  Codex-only provenance in canonical `performer_event.source`, together with
  performer binding id and generation.
- Unknown fields/kinds/versions, non-JSON and oversized payloads, invalid state
  combinations, and arbitrary provider/secret transport fields fail closed.
- Focused verification: `29 passed` across local runtime and package-boundary
  tests. Final canonical verification: `839 passed, 1 skipped` via `make test`.
- Code simplification retained the shared message base and centralized bounded
  serialization; no additional behavior was introduced.
- Independent code-view: PASS with no mandatory findings; the reviewer also
  ran 36 focused local-runtime, boundary, and private-IPC tests.
- Real Linear/Codex execution remains Phase 7 and was not run.
