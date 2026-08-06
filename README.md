# Symphony

Symphony advances one explicitly selected Linear Root Issue through small
Cycles. Each Cycle contains one workspace-write Execute session followed by an
independent read-only Audit session. V1 runs manually on one machine with one
caller-supplied workspace and external run directory, and creates one pull
request only after Root completion is independently verified. The only public
execution mode runs one complete Root; focused tests call the same internal
boundaries without a second Linear mutation command.

Linear is the visible workflow plane. Symphony uses five shared canonical
statuses for Root, Cycle, Execute, and Audit: `Todo` (`unstarted`), `In Progress`
(`started`), `In Review` (`started`), `Done` (`completed`), and `Canceled`
(`canceled`). Conductor resolves them by exact name and expected type, creates a
missing canonical state, and stops on ambiguity or provider failure. Other team
states are ignored; callers do not provide status IDs, and issue status changes
are explicit at every lifecycle boundary.

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

## Run One Root

The caller must provide an existing isolated Git workspace, its configured
remote, and a writable evidence directory outside that workspace. Authentication
is supplied in the process environment: `LINEAR_API_KEY` for Linear,
optional role-specific `SYMPHONY_EXECUTE_CODEX_API_KEY`,
`SYMPHONY_EXECUTE_CODEX_BASE_URL`, `SYMPHONY_AUDIT_CODEX_API_KEY`, and
`SYMPHONY_AUDIT_CODEX_BASE_URL` values for the two non-interactive Codex
roles, and `GH_TOKEN` or `GITHUB_TOKEN` for pull request creation. Generic
`CODEX_API_KEY` and `CODEX_BASE_URL` values may be used as a fallback. These
keys and base URLs are startup environment only; they are not fields in the
public `HarnessRunRequest`.

```bash
npm run dev -w @symphony/conductor -- run \
  --linear-root ENG-123 \
  --workspace /absolute/root-workspace \
  --dir /absolute/root-run-directory \
  --agent codex \
  --execute-model <execute-model> \
  --execute-reasoning-effort <execute-effort> \
  --audit-model <audit-model> \
  --audit-reasoning-effort <audit-effort> \
  --max-cycles 4
```

`--agent` is optional and defaults to `codex`. Omitted role model or reasoning
overrides use the user's local `~/.codex` configuration; omitted credentials
use the user's local Codex authentication. The architecture does not
hardcode a capability matrix, default model, or default effort. Execute and
Audit are separate fresh roles and may use different providers/capabilities,
but there is no dynamic per-Cycle routing, plugin discovery, compatibility
alias, or shared cross-role transcript.

The Conductor does not load or modify `.env`; the caller or repository E2E
supervisor supplies its allowlisted startup values to the relevant boundary
process.

The external run directory is a private, caller-owned diagnostic plane. Failed
Agent launches may retain bounded raw JSONL, stderr, and causal error context
there, with local file permissions, while public and Linear results remain
sanitized. Diagnostic references are opaque local paths only; raw evidence and
mechanically indexed `thread_id` values are never supplied to Audit or Root
Reconcile. Retention and deletion belong to the caller. On failure, the golden
E2E runner archives diagnostic evidence before cleaning its owned local/branch
resources, reports only `diagnostic_ref`, and preserves the Linear Root tree for
inspection. It archives the fixture Issue tree only after visible completion is
verified.
