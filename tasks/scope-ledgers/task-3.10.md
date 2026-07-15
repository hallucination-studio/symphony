# Task 3.10 scope ledger

## authorized

- Accept a Tauri-internal project id and canonical existing repository directory.
- Atomically create one durable generation-1 desired Conductor binding.
- Persist isolated identity/data-root key with desired running and observed pending state.

## required_consequences

- Validate connected accessible project and active project/repository/conductor uniqueness.
- Keep repository paths out of command output and logs.
- Reopen the exact committed identity after Desktop restart.
- Wire the single private command through the existing Desktop dispatcher and
  protocol allowlist; no second command or transport is introduced.
- Add the migration's columns/index through the existing schema constants file.

## out_of_scope

- Native directory-picker UI, process start, session creation, binding edits, deletion, retry controls, installer/enrollment, polling, or dispatch.
- Browser/HTTP Create Conductor API.
- Real Linear/Codex execution.

## assumptions_requiring_approval

- None.

## deferred_ideas

- Task 4.6 starts/reconciles the bundled Conductor after this commit.
