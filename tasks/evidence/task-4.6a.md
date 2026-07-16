# Task 4.6a evidence

- Start commit: `0b2d71d` (`docs: split dynamic session handoff from
  supervision`).
- Scope ledger: `tasks/scope-ledgers/task-4.6a.md`;
  `assumptions_requiring_approval` is empty.
- Desktop now starts the long-lived Podium sidecar with one inherited broker
  socket. Later per-Conductor Podium endpoints are transferred over that broker
  with `SCM_RIGHTS`; the broker carries only bounded exact identity/session
  metadata and OS descriptors.
- Podium adopts each transferred endpoint into the existing local session
  registry and requires exact protocol version, conductor, instance, project,
  binding, generation, session, and expected PID correlation before accepting
  the Conductor handshake.
- Duplicate process identity, binding, and replayed session IDs fail closed.
  Invalid metadata, ancillary truncation, missing/multiple descriptors, wrong
  peer handshakes, and oversized frames close transferred descriptors and emit
  bounded sanitized structured failures.
- Shutdown closes the broker and all pending/online adopted sessions before a
  bounded thread join. A regression test stopped Podium while a transferred
  endpoint was still awaiting its handshake and observed peer EOF in under one
  second.
- Rust descriptor tests used `recvmsg` to extract the transferred FD, wrote
  through the adopted endpoint, and returned the bounded acceptance response.
  `cargo test` passed `21` tests with no warnings.
- Python focused verification passed `43` tests across dynamic handoff,
  Desktop lifecycle/protocol, local sessions, and package boundaries. The
  installed Python sidecar subprocess accepted two sequential sessions after
  startup without restarting Podium and shut down with exit code 0.
- Final canonical verification: `908 passed, 1 skipped` via `make test`.
- Forbidden-path scans found no filesystem/network/named listener, bearer,
  token, shared secret, runtime payload relay, ambient PATH/PYTHONPATH command,
  or cross-package import in the new handoff path. `git diff --check` passed.
- Platform result: macOS exercised the Unix `SCM_RIGHTS` path. Linux shares the
  same cfg-unix implementation but was not cross-compiled in this environment.
  Windows has an explicit `podium_dynamic_session_handoff_unavailable` No-Go;
  no named/network/relay fallback is present. Only the macOS Rust target was
  installed, so a Windows duplicated-handle implementation is not claimed.
- `code-review-and-quality`: fixed partial stream writes, ancillary truncation,
  replayed session IDs, strict metadata types, descriptor ownership, pending
  handshake shutdown, and non-Unix conditional compilation. No remaining
  in-scope correctness, architecture, security, readability, or performance
  blocker was identified.
- Acceptance result: approved Unix inherited-handle design completed and
  cross-process behavior proven; Windows recorded as the required explicit
  No-Go rather than an unapproved transport fallback. Task 4.6b supervision was
  not started.
