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

[`docs/architecture/README.md`](docs/architecture/README.md) is the architecture
entry point and the only design-document set maintained in this repository.
These documents define the target architecture; they do not claim that every
target has already been implemented and do not define a migration plan.

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

## Current repository commands

The checked-in implementation remains in transition. Use the commands provided
by the current tree while implementing the ordered architecture work.

```bash
make install
make test
make dev
make stop
```

Focused Python tests require every current package source root:

```bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest path/to/test_file.py -q
```

Run the current services directly:

```bash
.venv/bin/performer --turn-request-path /tmp/turn-request.json --turn-result-path /tmp/turn-result.json
.venv/bin/conductor --port 8081 --data-root ./.conductor
.venv/bin/podium api --host 127.0.0.1 --port 8090
```

Podium web development:

```bash
cd packages/podium/web
npm run dev
npm run build
npm run test
npm run lint
npm run design:lint
```

See [`packages/podium/web/DESIGN.md`](packages/podium/web/DESIGN.md) before
changing the UI.
