# Real flow

`tools/real_flow.py` is the only supported real-flow entrypoint. It is a small
preflight/observation runner, not a scenario registry or a second acceptance
system.

Prepare a fixed staged Codex seed (never `~/.codex`) and set:

```bash
export SYMPHONY_E2E_CODEX_HOME_SEED=/path/to/staged-seed
export SYMPHONY_E2E_PROJECT_SLUG=MYPROJECT
export SYMPHONY_E2E_PODIUM_URL=https://podium.example
export LINEAR_API_KEY=...
```

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
