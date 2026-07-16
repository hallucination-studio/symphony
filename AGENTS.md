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

## Target architecture invariants

- Symphony is one product with four responsibilities: Podium Desktop, Podium,
  Conductor, and Performer.
- Podium Desktop, Podium, and Conductor target TypeScript; Performer remains a
  Python process; the Desktop host uses Tauri/Rust.
- Linear Issue Tree is workflow authority. Conductor must not introduce a
  workflow database, queue, checkpoint store, or mirrored Work Node state.
- Podium owns Linear OAuth, tokens, project catalog, bindings, the Linear SDK,
  and `podium.db`. Linear SDK types and credentials must not cross into
  Conductor.
- Conductor resolves its project through the Conductor Project Label, rebuilds
  root state from Linear and Git, schedules roots and leaves, manages Git
  worktrees, and launches one Performer process per Turn.
- Performer exclusively owns Provider SDK integrations and resumes the
  Provider conversation through the opaque `performer_id`.
- Performer Profiles belong to Conductor, use isolated `CODEX_HOME`
  directories, and are controlled through the approved profile-control
  boundary. Symphony must not read or rewrite Codex-owned configuration files.
- Cross-process communication uses closed, versioned schemas and generated
  types. Roles depend on contracts and interfaces, never another role's
  implementation.
- Public boundaries use the naming and module rules in
  `docs/architecture/code-organization.md`; business vocabulary follows
  `docs/architecture/glossary.md`.

## Scope discipline

For every non-trivial slice, record:

- `authorized`
- `required_consequences`
- `out_of_scope`
- `assumptions_requiring_approval`
- `deferred_ideas`

Production work starts only when `assumptions_requiring_approval` is empty.
Prefer the smallest change that satisfies the authorized outcome. Do not infer
new product behavior, durable state, APIs, configuration, compatibility paths,
permissions, integrations, or migration steps from the target architecture.

## Repository commands

The checked-in implementation is still in transition. Use the commands that
exist in the current tree:

```bash
make install
make test
make dev
make stop
```

Focused Python tests need all current package source roots:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest path/to/test_file.py -q
```

Podium web commands:

```bash
cd packages/podium/web
npm run dev
npm run build
npm run test
npm run lint
npm run design:lint
```

Before any Podium UI change, read `packages/podium/web/DESIGN.md`. Its tokens
and the matching CSS custom properties are normative.

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
- UI changes must run the relevant web tests, lint, build, and design lint.
- Runtime behavior that spans processes or external systems requires evidence
  from the real boundary; local mocks alone are not sufficient.
- Final reports must state what was changed, exact verification performed, and
  any residual risk or unverified behavior.
