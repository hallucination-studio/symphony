# AGENTS.md

This file contains the repository-wide working rules for coding agents.

## Sources of truth

- [`docs/architecture/README.md`](docs/architecture/README.md) is the entry
  point for the approved target architecture.
- The files under `docs/architecture/` own their named concerns. Follow their
  documented boundaries and do not create a second description of the same
  design elsewhere.
- The architecture is a target proposal, not a claim that the current
  implementation already matches it and not an implicit migration plan.
- `README.md` is an operational repository entry point, not an architecture
  authority.
- Do not add ADR, AHR, `docs/decisions`, legacy product-design, or legacy
  module-baseline documents unless the user explicitly asks for them. Update
  the appropriate `docs/architecture/` source-of-truth document instead.

## Target architecture

Architecture details are intentionally not duplicated in this file. Read
[`docs/architecture/README.md`](docs/architecture/README.md) and the linked
named-concern owner documents before changing architecture, contracts, module
boundaries, or product behavior.

Follow the reading order in the architecture entry point. Load the workflow
model and only the named-concern documents relevant to the task; do not turn a
local change into a restatement or speculative implementation of the whole
target architecture.

## Working method

- Inspect before editing: read the files to be changed, their focused tests,
  the interfaces they depend on, and one nearby example of the same pattern.
- For non-trivial work, translate the request into observable acceptance
  criteria, record scope, and use a short plan whose steps name their checks.
- Surface uncertainty before production edits. State material assumptions,
  conflicting evidence, and tradeoffs. Proceed on a documented, reversible
  assumption only when it cannot change product behavior or an owned boundary;
  otherwise record it under `assumptions_requiring_approval` and stop.
- Prefer the smallest existing pattern that satisfies the request. Do not add
  speculative features, abstractions, configurability, dependencies, or
  compatibility behavior.
- Make surgical changes. Every changed line must trace to the authorized
  outcome; do not refactor, reformat, or remove unrelated code. Remove only
  artifacts made unused by the current change.
- Preserve uncommitted user work. Inspect the worktree before editing and work
  with overlapping changes rather than discarding or overwriting them.
- Continue through the defined checks until the acceptance criteria are met.
  Stop when they are met; record useful adjacent ideas as deferred work.

## Scope discipline

For every non-trivial slice, establish:

- `authorized`: the requested, observable outcome.
- `required_consequences`: code, contracts, tests, or documentation that must
  change for that outcome to be correct.
- `out_of_scope`: adjacent work deliberately excluded from the slice.
- `assumptions_requiring_approval`: unresolved choices that could change
  behavior, boundaries, durable state, permissions, integrations, or rollout.
- `deferred_ideas`: useful follow-up work that is not required now.

This scope record can live in the active task plan or issue; do not create a
persistent scope-ledger task directory. Keep the record proportional to the
task, and never treat a task artifact as architecture authority. Durable
product decisions belong only in the appropriate named `docs/architecture/`
source of truth.

Production work starts only when `assumptions_requiring_approval` is empty.
Prefer the smallest change that satisfies the authorized outcome. Do not infer
new product behavior, durable state, APIs, configuration, compatibility paths,
permissions, integrations, or migration steps from the target architecture.

## Repository commands

The target workspace is an npm workspaces repository using ESM TypeScript;
authoritative engine constraints live in `package.json`. The legacy runtime
has been removed. Use these target-workspace commands:

```bash
make install
make build
make lint
make typecheck
make test
make test-all
make dev
make stop
```

Focused checks:

```bash
npm test -w @symphony/conductor
npm run typecheck -w @symphony/conductor
npm run test:architecture
```

## Engineering rules

- Preserve role and import boundaries even while the implementation is being
  migrated.
- Keep SDK objects, database records, process handles, secrets, and arbitrary
  metadata out of public contracts.
- Never expose tokens, cookies, passwords, client secrets, API keys,
  authorization headers, or raw profile credentials in browser responses,
  logs, fixtures, or final answers.
- Fail closed with a sanitized, actionable reason. Do not swallow exceptions,
  hide failed attempts, or leave indefinite retries without visible progress.
- Use structured, correlated logs for orchestration changes and keep durable
  state/API visibility consistent with terminal failures.
- Use small role-owned modules and existing structured models rather than
  ad-hoc dictionaries or string parsing.
- Do not add compatibility shims for retired Symphony packages, commands,
  labels, state, or documents unless explicitly authorized.

## Verification

- Define success as observable checks before changing behavior. Add or update
  the narrowest test that would detect the requested behavior or regression.
- Run the narrowest relevant checks first, then the broader suite when the
  change warrants it.
- Documentation-only changes must at least verify links, removed-path
  references, and repository status.
- Runtime changes must run the relevant Conductor tests, lint, typecheck, and
  build.
- Runtime behavior that spans processes or external systems requires evidence
  from the real boundary; local mocks alone are not sufficient.
- Review the final diff and repository status. Confirm that every changed line
  belongs to the recorded scope and that unrelated user changes remain intact.
- Never claim a command or boundary check passed unless it was run. Report the
  exact failure or unverified boundary when a required check cannot complete.
- Final reports must state what was changed, exact verification performed, and
  any residual risk or unverified behavior.
