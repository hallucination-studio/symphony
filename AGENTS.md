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
- Linear custom statuses, native archive flags, Issue Tree, and managed records
  are workflow authority. Conductor must not introduce a workflow database,
  queue, checkpoint store, or mirrored Work Node state.
- Podium owns Linear OAuth, tokens, project catalog, bindings, the Linear SDK,
  and `podium.db`. Linear SDK types and credentials must not cross into
  Conductor.
- Conductor resolves its project through the Conductor Project Label, rebuilds
  root state from active and archived Linear facts plus Git, hosts Root
  Reconciliation, manages one Git worktree per Root, and materializes closed
  Root Reconciler directives. It does not run a model or interpret Stage
  Results and user comments to choose the next action.
- Root, Cycle, and Plan/Work/Verify use kind-restricted subsets of one Linear
  Team workflow. Findings, attempts, budgets, progress, and Human overrides
  are durable Linear facts; Root-level convergence limits are mechanical and
  survive every Conductor or Performer restart.
- Conductor is always the Performer caller. Performer exclusively owns
  Provider SDK integrations and gives each Root one Reconciler thread plus
  isolated Plan, Work, and Verify threads per Cycle; the Work thread spans
  multiple Work Issues and turns in that Cycle. Performer never calls
  Conductor, and Provider threads are runtime continuity rather than durable
  workflow authority.
- Root Reconciler is the only model-driven workflow next-step decision role.
  It reads the complete active and archived Root Tree, handles ordinary human
  comments with durable replies, and returns one closed, versioned directive.
  Plan, Work, and Verify return strong typed Results and do not mutate the DAG
  or create Human Actions directly.
- Root and Cycle user timelines are projected to their corresponding Linear
  Issue comments by typed event subscribers after durable read-back. Business
  workflow modules do not render timeline comments directly. Required Linear
  timeline or Reconciler reply writes must read back successfully before the
  Root can advance; failures stop that Root and emit correlated sanitized logs.
- Podium Desktop is a control-plane and observability surface only. It must not
  expose or mutate Root, Cycle, Stage, Human Action, Result, Finding, delivery,
  or workflow-next-step state. Workflow interaction stays in Linear; Desktop
  exposes only Linear connected/disconnected and Conductor online/offline.
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
npm test -w @symphony/podium-desktop
npm run typecheck -w @symphony/conductor
.venv/bin/python -m pytest apps/performer/tests -q
cd apps/podium-desktop/src-tauri && cargo test
```

Before any Podium UI change, read `apps/podium-desktop/DESIGN.md`. Its visual
tokens and matching CSS custom properties are normative; architecture and
product behavior remain owned by `docs/architecture/`.

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
- UI changes must run the relevant Desktop tests, lint, typecheck, and build.
- Runtime behavior that spans processes or external systems requires evidence
  from the real boundary; local mocks alone are not sufficient.
- Final reports must state what was changed, exact verification performed, and
  any residual risk or unverified behavior.
