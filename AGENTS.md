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

## Scope discipline

For every non-trivial slice, establish:

- `authorized`
- `required_consequences`
- `out_of_scope`
- `assumptions_requiring_approval`
- `deferred_ideas`

This scope record can live in the active task plan or issue; do not create a
persistent scope-ledger task directory, and never treat a task artifact as
architecture authority. Durable product decisions belong only in the appropriate named
`docs/architecture/` source of truth.

Production work starts only when `assumptions_requiring_approval` is empty.
Prefer the smallest change that satisfies the authorized outcome. Do not infer
new product behavior, durable state, APIs, configuration, compatibility paths,
permissions, integrations, or migration steps from the target architecture.

## Repository commands

The legacy runtime has been removed. Use the target-workspace commands:

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

- Run the narrowest relevant checks first, then the broader suite when the
  change warrants it.
- Documentation-only changes must at least verify links, removed-path
  references, and repository status.
- Runtime changes must run the relevant Conductor tests, lint, typecheck, and build.
- Runtime behavior that spans processes or external systems requires evidence
  from the real boundary; local mocks alone are not sufficient.
- Final reports must state what was changed, exact verification performed, and
  any residual risk or unverified behavior.
