# T12 Conductor Process Restart Evidence

## authorized

- Add E2E harness support for an abrupt Conductor child-process exit.
- Prove a fresh Conductor process can re-enter the existing private protocol
  boundary after the previous process was killed.

## required_consequences

- The test launches the real Conductor entrypoint twice.
- The first process is terminated with `SIGKILL` after handshake and runtime
  reporting.
- The second process receives a fresh instance identity, completes a new
  handshake, and emits a runtime report through the same external handler.
- No secret, credential, or provider response is included in the evidence.

## out_of_scope

- Real Linear network calls or credentialed external acceptance.
- Reconstructing a Root Issue Tree, Git worktree, or orphaned Stage execution
  across the process boundary.
- Changing Conductor production recovery behavior or marking T12 complete.

## assumptions_requiring_approval

None.

## deferred_ideas

- Replace the unbound protocol fixture with a serialized Linear/Git fixture and
  prove the complete Conductor recovery path before final T12 acceptance.
