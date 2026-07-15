# Task 4.2 evidence

- The process-local registry binds each inherited channel to exact Conductor,
  project, binding generation, instance, and expected-PID identity.
- The server accepts one exact nonce handshake, rejects wrong PID/stale
  generation/duplicates, and permanently closes rejected sessions.
- Process-exit notification closes the channel and immediately exposes offline;
  Desktop shutdown closes all remaining sessions.
- Registry records expose only approved identity and state fields and persist no
  session or secret data.
- Focused verification: `37 passed` across registry, private IPC, Desktop
  lifecycle, and package-boundary tests.
- Code simplification retained one process-local registry and one server facade;
  the closed local identity validation avoids importing private helpers.
- Independent code-view: PASS with no mandatory findings after active process
  uniqueness and embedded secret/JWT identity findings were corrected.
- Final canonical verification: `854 passed, 1 skipped` via `make test`.
- Real Linear/Codex execution remains Phase 7 and was not run.
