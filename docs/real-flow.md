# Real flow

The agent-facing staged design and acceptance rubric is
[`real-e2e-design.md`](real-e2e-design.md). It defines the OAuth, Linear,
Performer, and Overall phases, the existing code/test entrypoints they may
call, and the evidence required before claiming an MVP pass.

`tools/real_flow.py` is the only supported real-flow entrypoint. It owns one
`--phase all` batch (OAuth, Linear, Performer, Overall), its shared `run_id`,
phase reports, sanitized artifact manifest, and fixed exit codes. It is not a
scenario registry or a second acceptance system.

Prepare a fixed staged Codex seed (never `~/.codex`) and set:

```bash
export SYMPHONY_E2E_CODEX_HOME_SEED=/path/to/staged-seed
export SYMPHONY_E2E_PROJECT_SLUG=MYPROJECT
export SYMPHONY_E2E_PODIUM_URL=https://podium.example
export SYMPHONY_E2E_BROWSER_OBSERVATION_PATH=.test-real-flow/browser-observation.json
export SYMPHONY_E2E_CONDUCTOR_URL=http://127.0.0.1:8091
export SYMPHONY_E2E_FIXTURE_REPOSITORY=/path/to/disposable-bound-git-workspace
```

The seed may be created from an official ChatGPT login without an API token:

```bash
mkdir -p /path/to/staged-seed
CODEX_HOME=/path/to/staged-seed codex login
```

The operator may use the official Codex tooling to prepare the approved seed.
The runner treats the seed as opaque: it does not parse `config.toml`, read
`auth.json`, or import a provider SDK. It stages one isolated per-batch context
and shares that context with installed Performer control and turn processes.
It never reads `~/.codex`, uploads provider credential files, or places a token
in Podium. Any provider-owned refresh remains inside the staged context on the
Conductor machine.

When Podium requires an existing browser session, use the browser skill on the
Podium page to issue same-origin `fetch` requests for the public OAuth/project/
runtime/managed-run responses and save a JSON object containing `base_url`,
`captured_at`, and `observations` to `SYMPHONY_E2E_BROWSER_OBSERVATION_PATH`.
Do not read cookies, localStorage, or Authorization headers. The runner
validates the origin, freshness, closed public-field schema, and credential
redaction before using it.

The Linear phase removes `LINEAR_API_KEY` from its process environment and
uses only the existing `PODIUM_LINEAR_APP_ACCESS_TOKEN` through
`LinearFixture`. It never writes either credential to the report or passes it
to the managed Conductor/Performer path.

Run offline preflight first:

```bash
PYTHONPATH=tools .venv/bin/python tools/real_flow.py --offline
```

For a real project, run the services and then use:

```bash
PYTHONPATH=tools .venv/bin/python tools/real_flow.py \
  --phase all --project-slug MYPROJECT --out .test-real-flow/batch-report.json
```

Every phase runs and writes its report even when an earlier phase fails. Exit
`0` means all phases and Overall passed, `2` means a phase failed or Overall
was blocked/skipped, and `1` means the runner itself failed. Every exit writes
the final report plus a per-run artifact manifest. Product acceptance still
requires durable Conductor, Linear, and Podium evidence; the tool never
fabricates a passed gate.
