# E2E Testing

The public-boundary E2E suite runs the built Conductor against real Linear,
Git, GitHub, and the locally installed Codex app-server. The test runner never
imports Conductor internals and never receives the product mutation token.

## Commands

Build the process before running the provider test:

```bash
make build
npm run test:e2e:runner
npm run test:e2e
```

`test:e2e:runner` is deterministic and checks configuration, credential
separation, launcher framing, cleanup, and sanitized diagnostics. `test:e2e`
also runs the accepted Root scenario in
`tests/e2e/accepted-root.test.mjs`.

## Configuration

Create a local `.env` that is not committed. The runner requires:

```dotenv
SYMPHONY_E2E_LINEAR_HUMAN_TOKEN=...
SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED=true
SYMPHONY_E2E_PROJECT_SLUG_ID=...
SYMPHONY_E2E_CONDUCTOR_LAUNCHER_SOCKET=/absolute/path/to/launcher.sock
```

The socket must be served by the local deployment launcher. It starts
`apps/conductor/dist/main.js` with the product-only environment, including
`SYMPHONY_LINEAR_TOKEN`, `SYMPHONY_CODEX_API_KEY`,
`SYMPHONY_CODEX_MODEL`, `SYMPHONY_CODEX_BASE_URL`, and the three acknowledged
Linear provider capability attestations. The runner sends only an absolute
config path and receives sanitized JSONL lifecycle events.

Set `SYMPHONY_E2E_DIAGNOSTIC_EVENTS=1` only when needed. The optional output
contains event names and bounded reason codes, never credentials or raw agent
values.

## Fixture Ownership

The fixture actor uses the human Linear token to create temporary workflow
states and one delegated Root. It observes public Linear facts and archives
the issue tree and any states it created. The Git fixture uses the local `gh`
login to clone the repository, inspect the public PR/ref, and remove its
temporary branch, open PRs, and local directory.

The product is started only through the launcher after the fixture config is
written. Product shutdown runs before fixture cleanup. A failed cleanup is a
test failure; inspect the reported fixture identity before retrying.

## Codex Boundary

Conductor production roles start `codex app-server` through `CodexProcess`.
The native Work and Verify permission probes use the same app-server process
and its `command/exec` request with the role permission profile. They do not
invoke `codex sandbox`, start a second Codex surface, or require a model turn.

## Troubleshooting

- `invalid_e2e_configuration`: check the four required values, the absolute
  socket path, and that no production Linear token is in the runner environment.
- `conductor_start_failed` or `conductor_start_timeout`: confirm the launcher
  is listening and starts the freshly built `apps/conductor/dist` process.
- `fixture_operation_failed`: verify Linear access, project ownership, and the
  configured Symphony actor; verify `gh auth status` for the Git fixture.
- `conductor_runtime_failed`: inspect only sanitized diagnostics, then query
  Linear, the branch, and the PR using the fixture identities.

Never place tokens, cookies, API keys, or raw continuity values in command
output, checked-in fixtures, or this document.
