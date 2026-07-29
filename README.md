# Symphony

Symphony turns a Linear Root Issue into a verified pull request. Phase 1 is one
closed loop: plan, work, verify an exact commit, then create the PR.

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
- [Git worktree and delivery](docs/architecture/git-worktree-delivery.md)
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
