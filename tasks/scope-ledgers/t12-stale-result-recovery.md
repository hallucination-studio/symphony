# T12 Stale Result Recovery Boundary

## authorized

- Exercise the real Conductor entrypoint and real Performer fixture against a
  serialized Linear workflow Tree and a real Git repository/worktree.
- Start a Work Stage, change the Root to each terminal state (`Done` and
  `Canceled`) while the Stage is active, and deliver the old result afterward.
- Record evidence that terminal Root facts reject the result before durable
  terminal or completion evidence is written.

## required_consequences

- The real Performer writes a valid but late result from the old execution.
- Conductor reports a sanitized recovery problem and does not append a
  `stage_terminal` or `work_completion` record, mutate workflow state, or
  commit the stale result.
- The test uses separate process state and serialized boundary reads, and
  leaves no live Stage process after cleanup.

## out_of_scope

- Credentialed Linear network access and SDK physical requests.
- New stale-result protocol fields, retry policy, delivery, or final T12
  checklist completion.
- Replacing the existing unit correlation and terminal-state tests.

## assumptions_requiring_approval

None.

## deferred_ideas

- Add real-process stale-result coverage for a changed precondition while the
  Root remains non-terminal.
