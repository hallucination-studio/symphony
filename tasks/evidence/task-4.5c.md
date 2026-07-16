# Task 4.5c evidence

- Start commit: `b49129f` (`feat: apply complete Configure commands over IPC`).
- Scope ledger: `tasks/scope-ledgers/task-4.5c.md`;
  `assumptions_requiring_approval` is empty.
- TDD baseline: the bootstrap test module initially failed collection because
  `private_bootstrap_from_args` and `LocalRuntimeBootstrap` did not exist. A
  later secret-like handshake-correlation test failed before the model was
  hardened.
- The installed Conductor CLI now accepts one complete private bootstrap set:
  inherited FD, conductor/instance/project/binding identity, positive binding
  generation, and one-shot handshake correlation. Partial sets and host/port
  mixing fail closed before service construction.
- The bootstrap model constructs only the fixed protocol-v1 handshake and
  rejects invalid, path-traversal instance, or secret-like log identity.
- Private startup connects the Task 4.4 client before constructing/starting the
  service, never starts the HTTP server, and closes the IPC channel and service
  on SIGINT/SIGTERM or startup failure.
- Invalid/unavailable inherited FDs exit non-zero with a stable correlated,
  sanitized log and do not create `workflow.db`; handshake send failures close
  the acquired handle explicitly.
- Real subprocess verification proved that the FD works only through explicit
  `pass_fds`, Podium observes the exact handshake, SIGTERM exits with code 0,
  and the peer observes EOF with no orphan channel.
- `code-simplification`: the legacy and private lifecycles share one signal
  installation helper; no process abstraction, listener fallback, or second
  transport wrapper was introduced.
- `code-review-and-quality`: fixed invalid-argument traceback exposure,
  pre-validation state creation, legacy port/host default semantics, handshake
  handle cleanup, and secret-like correlation logging. No remaining in-scope
  blocker was identified.
- Focused verification: `66 passed, 1 skipped` across bootstrap subprocess,
  Conductor IPC, inherited-FD feasibility, local runtime contract, desktop
  bundle, and package-boundary tests.
- Final canonical verification: `895 passed, 1 skipped` via `make test`.
- Forbidden scan found no Podium token env, bearer/header/cookie/API-key,
  credential, URL, or listener call in the private bootstrap path;
  `git diff --check` and package-boundary checks passed.
- Acceptance score: `4/4` for the inherited bootstrap slice. Command receive
  and active tick cutover remain intentionally deferred to Task 4.5d, so no
  real Linear/Codex run applies here.
