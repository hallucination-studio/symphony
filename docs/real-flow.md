# Real flow

`tools/real_flow.py` is the only supported real-flow entrypoint. It is a small
preflight/observation runner, not a scenario registry or a second acceptance
system.

Prepare a fixed staged Codex seed (never `~/.codex`) and set:

```bash
export SYMPHONY_E2E_CODEX_HOME_SEED=/path/to/staged-seed
export SYMPHONY_E2E_PROJECT_SLUG=MYPROJECT
export SYMPHONY_E2E_PODIUM_URL=https://podium.example
```

The seed may be created from an official ChatGPT login without an API token:

```bash
mkdir -p /path/to/staged-seed
CODEX_HOME=/path/to/staged-seed codex login
```

For deterministic managed runs, set `cli_auth_credentials_store = "file"` in
that staged home's `config.toml` and verify that it contains the approved
`auth.json`. The runner copies approved seed files into each isolated attempt;
it never reads `~/.codex`, uploads `auth.json`, or places a token in Podium.
Codex refreshes ChatGPT OAuth credentials during use; any refresh remains on
the Conductor machine.

The read-only project preflight uses `LINEAR_API_KEY` when set, otherwise the
existing `PODIUM_LINEAR_APP_ACCESS_TOKEN` from the sourced environment. It
never writes either credential to the report or passes it to the managed
Conductor/Performer path.

Run offline preflight first:

```bash
PYTHONPATH=tools .venv/bin/python tools/real_flow.py --offline
```

For a real project, run the services and then use:

```bash
PYTHONPATH=tools .venv/bin/python tools/real_flow.py \
  --project-slug MYPROJECT --out .test-real-flow/report.json
```

The tool fails immediately on missing credentials, an unstaged runtime home,
or an inaccessible project. Every exit writes a sanitized report. Product
acceptance still comes from the Conductor gate and its durable Linear/Podium
evidence; the tool never fabricates a passed gate.
