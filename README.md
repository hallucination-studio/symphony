# Symphony

Symphony is one product composed of Podium Desktop, Podium, Conductor, and
Performer.

The repository is moving toward a Linear-authoritative architecture:

- Podium Desktop hosts the local product experience.
- Podium owns Linear OAuth, tokens, project catalog, bindings, and the Linear
  SDK.
- Conductor is a database-free TypeScript daemon that reconstructs workflow
  state from Linear and Git.
- Performer is a short-lived Python process that exclusively owns Provider SDK
  execution and resumes conversations through an opaque `performer_id`.
- Roles communicate through closed, versioned contracts rather than importing
  one another's implementations.

## Architecture

[`docs/architecture/README.md`](docs/architecture/README.md) is the target
architecture entry point and the only target-architecture design-document set
maintained in this repository. These documents do not claim that every target
has already been implemented and do not define a migration plan. Operational
verification is documented separately in the
[E2E testing strategy](docs/testing/e2e.md).

Key documents:

- [Root Issue workflow](docs/architecture/root-issue.md)
- [Linear end-to-end flow](docs/architecture/linear-flow.md)
- [Conductor](docs/architecture/conductor.md)
- [Performer](docs/architecture/performer.md)
- [Performer Profiles](docs/architecture/performer-profiles.md)
- [Podium](docs/architecture/podium.md)
- [Podium Desktop](docs/architecture/podium-desktop.md)
- [Contracts](docs/architecture/contracts.md)
- [Code organization](docs/architecture/code-organization.md)
- [Target repository layout](docs/architecture/repository-directory.md)
- [Roadmap](docs/architecture/roadmap.md)
- [Glossary](docs/architecture/glossary.md)

## Repository commands

The legacy runtime has been removed. The current tree is the Roadmap V1 target
workspace scaffold.

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

Before changing the UI, read
[`apps/podium-desktop/DESIGN.md`](apps/podium-desktop/DESIGN.md). It owns visual
tokens only; product behavior remains owned by `docs/architecture/`.
