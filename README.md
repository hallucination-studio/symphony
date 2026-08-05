# Symphony

Symphony advances one explicitly selected Linear Root Issue through small
Cycles. Each Cycle contains one workspace-write Execute session followed by an
independent read-only Audit session. V1 runs manually on one machine with one
caller-supplied workspace and external run directory, and creates one pull
request only after Root completion is independently verified. A one-shot Cycle
mode runs one existing Execute or Audit for focused testing and debugging.

## Architecture

[`docs/architecture/README.md`](docs/architecture/README.md) is the target
architecture entry point and the only target-architecture design-document set
maintained in this repository. These documents do not claim that every target
has already been implemented and do not define a migration plan. Operational
verification is documented separately in the
[E2E testing strategy](docs/testing/e2e.md).

Key documents:

- [Root Issue workflow](docs/architecture/root-issue.md)
- [Conductor](docs/architecture/conductor.md)
- [Root Reconciliation](docs/architecture/root-reconciliation.md)
- [Performer](docs/architecture/performer.md)
- [Root Workspace and Pull Request](docs/architecture/workspace.md)
- [Contracts](docs/architecture/contracts.md)
- [Roadmap](docs/architecture/roadmap.md)

## Repository commands

The repository contains the Phase 1 Conductor workspace and its architecture
checks.

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
