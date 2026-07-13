# ADR-0006 Performer Backend Boundary Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan in order. Parallel agents are allowed only for explicitly
> assigned, non-overlapping file sets; the primary agent owns integration and
> phase-wide verification. Track progress with tasks/todo.md.

**Goal:** Correct the provider boundary so Performer hides Codex, Claude, and
future backend details behind one internal interface; Conductor consumes only
provider-neutral `performer_api` contracts and installed Performer processes;
then complete the real Linear/OAuth/Performer MVP acceptance run.

**Architecture:** Podium stores only Symphony execution and turn policy.
`performer_api` owns closed turn/control/capability/readiness wire contracts.
Performer owns the internal `PerformerBackend` Protocol/ABC, explicit closed
registry, provider SDKs, login/config/Check behavior, policy mapping, and
sanitization. Conductor owns one fixed backend process context, generic
control/turn subprocess coordination, durable readiness, and workflow state.
Codex is the first production backend; a production Claude adapter remains a
separately approved implementation.

**Tech stack:** Python 3.12+, SQLite, PostgreSQL/asyncpg, FastAPI, React,
TypeScript, TanStack Query, pytest, Vitest, and `openai-codex 0.1.0b3` only
inside the Performer Codex backend.

---

## Plan basis

Phase 1 was completed and committed as `e3b5b09` before the ownership defect
was discovered. Its policy/profile hard cut remains valid. The former Phase 2
implementation direction is superseded: uncommitted Conductor `CodexController`
work is not an approved baseline and must be removed or rewritten during the
corrected implementation phase.

Historical baseline recorded before Phase 1 and before the current uncommitted
wrong-direction Phase 2 work:

- make test: 188 passed.
- Podium Web npm run test: 27 passed.
- Podium Web npm run lint: clean.
- The worktree was clean at that historical checkpoint. It is not a claim about
  the current documentation-only correction turn.

Already-working behavior is a regression boundary, not new implementation
work:

- HTTP polling, Linear OAuth/installations, project selection, binding,
  delegation epochs, dispatch deduplication, and Linear proxying.
- Ordered plan/Sub Issue execution and fenced Performer request/result files.
- One Gate rework followed by blocking on the second failure.
- Duplicate-result idempotency and stale-result rejection.
- Durable runtime waits, Linear Human Action projection, structured logs, and
  secret redaction.
- One real-flow entrypoint, `tools/real_flow.py`, with OAuth, Linear, Performer,
  and Overall reports under one run id.

## Scope ledger

### Authorized

- Implement accepted ADR-0006 and the corrected runtime design while retaining
  the still-valid ADR-0005 policy/no-store outcomes.
- Keep mutable runtime_profiles, performer_profiles, and performer_bindings
  without revision tables.
- Remove Codex config documents/hashes, credential records/references, local
  slots, per-attempt Codex-home copies, auth reconciliation, and TOML parsing.
- Add provider-neutral shared turn/control/capability/readiness contracts.
- Add a Performer-owned backend interface and explicit closed registry.
- Keep all official Codex SDK login/logout/account/config/Check/turn behavior
  inside the Performer Codex implementation.
- Add generic Conductor subprocess coordination and readiness gating without a
  provider SDK dependency.
- Add a provider-neutral Podium live API and capability-driven Runtimes UI.
- Rewrite the existing real E2E to exercise Check and turns through the
  installed Performer boundary and finish MVP acceptance.

### Required consequences

- Login, logout, and supported config writes invalidate readiness
  before the SDK operation starts.
- Conductor startup resets readiness to unchecked but retains prior sanitized
  Check evidence.
- A non-ready managed run blocks visibly in SQLite, logs, Podium managed-runs,
  and Linear; it resumes only after a user-triggered Check passes.
- Podium persists no provider-owned account, config, path, credential, or Check
  data.
- Production reuses one fixed allowlisted backend environment. Only real E2E
  stages one isolated per-batch provider context.
- Secret-bearing control operations use pipes and never persisted JSON files.
- Provider SDKs, generated types, login handles, config parsing, and provider
  response classification exist only in Performer backend implementations.
- Existing Gate, retry, wait, fencing, logging, and Linear behavior remains
  unchanged except where readiness must block and resume it.

### Out of scope

- Multiple provider accounts or selectable slots in one Conductor.
- Arbitrary provider config editing or custom-provider credential upload.
- Direct provider config/credential-file reads or writes outside the owning
  Performer backend's official SDK surface.
- Automatic Check, rollback, durable login jobs, or a remote app-server.
- A production Claude SDK/auth/config implementation without a separately
  approved adapter design.
- Dynamic backend plugins, entry points, a provider marketplace, or switching
  backend inside one managed run.
- Another runtime transport, scheduler, E2E runner, or compatibility layer.
- A visual redesign of Podium.

### Assumptions requiring approval

- None. ADR-0006 and the corrected companion runtime design were approved on
  2026-07-13.

### Deferred ideas

- A separately specified Claude backend, multi-account selection, automatic
  Check, transactional rollback, broader provider editing, and managed
  credential brokerage.

## Required execution cadence

Every phase follows this exact sequence:

1. Finish the whole coherent phase, including its focused tests.
2. Run the phase focused suite.
3. Run make test once and save the complete output.
4. Do not patch the first visible failure. Inventory every FAILED and ERROR
   item and group them by one shared root cause.
5. Record each new group in `.test/adr-0006/phase-N-root-causes.md` with:
   failing tests, shared cause, owning module, repair set, and regression tests.
6. Repair all root-cause groups as grouped changes.
7. Rerun the phase focused suite, then rerun make test once.
8. Commit the green phase checkpoint.

If the second make test exposes a new set, repeat the complete inventory and
grouping step. Never enter a one-test/one-patch loop.

Common focused-test prefix:

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest
~~~

## Dependency graph

~~~text
Symphony policy contracts
  -> Podium profile loader and PostgreSQL rows
     -> project.configure and Conductor local projection
        -> provider-neutral turn/control/capability contracts
           ├── PerformerBackend interface and explicit registry
           │    ├── CodexBackend turn mapping
           │    └── Performer control host and Codex control adapter
           └── Conductor generic coordinator using fake Performer process
                 -> fixed context and slot removal
                    -> generic readiness block/resume
                       -> provider-neutral Podium relay/routes
                          -> Web contracts and capability-driven Performer UI
                             -> real E2E and final acceptance
~~~

## Target file map

Create:

- packages/performer-api/src/performer_api/performer_control.py
- packages/performer/src/performer/backend_interface.py
- packages/performer/src/performer/backend_registry.py
- packages/performer/src/performer/backends/codex.py
- packages/performer/src/performer/control_host.py
- packages/conductor/src/conductor/performer_control.py
- packages/podium/src/podium/podium_routes_performer_control.py
- packages/podium/web/src/pages/RuntimesPerformerDrawer.tsx
- packages/podium/web/src/styles/performer-control.css
- tests/test_performer_api_control.py
- tests/test_performer_api_runtime_policy.py
- tests/test_performer_backend_contract.py
- tests/test_performer_control_cli.py
- tests/test_conductor_performer_control.py
- tests/test_podium_performer_control.py
- packages/podium/web/src/pages/RuntimesPerformerDrawer.test.tsx

Delete after callers reach zero:

- packages/conductor/src/conductor/codex.py
- tests/test_conductor_codex.py
- packages/conductor/src/conductor/performer_credentials.py
- tests/test_conductor_performer_credentials.py
- packages/podium/src/podium/podium_routes_live_credentials.py
- tests/test_podium_live_credentials.py

The live lease/reply transport remains in live_conductor_relay.py and the
replacement route module; only credential-slot vocabulary and operations are
removed.

## Parallel execution boundaries

Task 4 freezes the shared wire contracts and must complete first. After that:

- Performer interface/turn work and Performer control-host work may proceed in
  parallel on non-overlapping modules.
- Conductor coordinator/store work may proceed in parallel against a fake
  Performer control process and the frozen `performer_api` contracts.
- Podium relay/routes and Web contract work may proceed in parallel only after
  the provider-neutral HTTP/live-operation contract is frozen.
- The capability-driven UI starts after Web types/hooks are stable.

The primary agent owns integration edits to shared files including
`performer/cli.py`, `conductor_service.py`, `workflow_driver.py`, `store.py`,
`conductor_api.py`, and `live_conductor_relay.py`. Parallel workers must not
edit the same shared file.

---

## Phase 1: Hard-cut Codex-owned profile data

### Task 1: Replace the shared TOML contract with Symphony policy contracts

**Files**

- Modify: packages/performer-api/src/performer_api/codex_runtime.py
- Modify: packages/performer-api/src/performer_api/__init__.py
- Replace assertions: tests/test_performer_api_codex_runtime.py

**Implementation contract**

RuntimePolicy is a closed, secret-free object with exactly:

~~~json
{
  "version": 1,
  "model": "gpt-5.4",
  "model_provider": "openai",
  "approval_mode": "auto_review",
  "reasoning_effort": "high",
  "reasoning_summary": "auto",
  "sandbox": {
    "plan": "read_only",
    "execute": "workspace_write",
    "gate": "read_only"
  },
  "initialize_timeout_ms": 5000,
  "turn_timeout_ms": 3600000,
  "initialize_max_attempts": 4,
  "overload_max_attempts": 5
}
~~~

This is the canonical real-E2E policy fixture, not a hard-coded production
default. Production profiles may select another bounded model/provider while
retaining the approved sandbox invariant.

PerformerProfileConfig carries:

- binding_id and positive binding_config_version;
- performer_binding_id, performer_profile_id, runtime_profile_id;
- performer_kind and runtime_kind;
- execution_policy plus execution_policy_sha256;
- turn_policy plus turn_policy_sha256.

Both hashes are SHA-256 of canonical JSON. RuntimePolicyError replaces
CodexRuntimeConfigError as the exported validation error. The parser rejects
unknown policy keys, invalid enum values, non-positive timeout/retry values,
oversized nested policy, profile revision fields, and every Codex-owned field
named in ADR-0005:
config_format, config_document, config_sha256, credential_id, credential_ref,
slot_id, api_host, codex_home, and codex_endpoint.

Approval mode is deny_all or auto_review. Reasoning effort is none, minimal,
low, medium, high, or xhigh. Reasoning summary is none, auto, concise, or
detailed. The sandbox map is fixed to plan=read_only,
execute=workspace_write, and gate=read_only. Model and provider are bounded
non-empty strings.

Remove CodexRuntimeConfig, validate_codex_toml, TOML imports, Codex key
allowlists, forced file credential-store validation, and their exports.

**Test-first steps**

- Add tests for canonical execution/turn hashes and round-trip serialization.
- Add parameterized rejection tests for each Codex-owned field.
- Add enum/bounds tests for model/provider, approval, reasoning, sandbox,
  timeout, and retry values.
- Keep the no-profile-revision regression.
- Implement the smallest contract that makes the new tests pass.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_performer_api_codex_runtime.py -q
~~~

**Acceptance**

- No shared contract parses or stores Codex config text.
- Public summaries expose ids and policy hashes, never policy documents or
  Codex-owned values.
- The exact policy document above is accepted and a one-field mutation changes
  only the relevant hash.

### Task 2: Change Podium profile ingestion and PostgreSQL storage to policy JSON

**Files**

- Modify: packages/podium/src/podium/performer_profiles.py
- Modify: packages/podium/src/podium/store/_postgres_schema_statements.py
- Modify: packages/podium/src/podium/store/_postgres_profiles.py
- Modify: packages/podium/src/podium/podium_performer_profiles.py
- Modify: tests/test_podium_performer_profiles.py
- Modify: tests/test_podium_storage.py

**Implementation contract**

The profile directory contains:

~~~text
<profile>/runtime.json
<profile>/performer.json
~~~

runtime.json accepts only runtime_kind and execution_policy. performer.json
accepts only performer_kind and turn_policy. The loader generates the current
runtime/Performer ids from workspace and profile name as it does today.

Fresh PostgreSQL rows become:

~~~text
runtime_profiles:
  runtime_kind
  execution_policy JSONB
  execution_policy_sha256

performer_profiles:
  performer_kind
  runtime_profile_id
  turn_policy JSONB
  turn_policy_sha256
~~~

Keep current mutable rows, state, ownership timestamps, performer_bindings,
generation bumps, and no revision tables. Because this repository uses a hard
fresh-schema cut, do not add migration or compatibility columns.

Generation changes when either referenced policy hash changes. SQL record
decoders must return dictionaries, not JSON strings.

**Test-first steps**

- Rewrite bundle fixtures to runtime.json and performer.json.
- Prove runtime.toml is no longer a valid required input.
- Prove unknown/Codex-owned fields are rejected at ingestion.
- Update SQL placeholder, row-decoding, generation-bump, and public-summary
  tests for the renamed columns.
- Implement loader and store changes only after the new tests fail for the old
  architecture.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_podium_performer_profiles.py tests/test_podium_storage.py -q
~~~

**Acceptance**

- No Podium profile row or loader field contains TOML/config/credential data.
- Existing performer_binding generation fencing still changes on referenced
  policy changes.
- Managed-run/public summaries expose policy hashes only.

### Task 3: Cut project.configure and Conductor profile projection to policy only

**Files**

- Modify: packages/podium/src/podium/podium_project_bindings.py
- Modify: packages/conductor/src/conductor/conductor_podium_sync.py
- Modify: tests/test_conductor_podium_sync.py
- Modify: tests/test_podium_performer_profiles.py
- Modify: tests/test_podium_storage.py

**Implementation contract**

project.configure carries:

~~~json
{
  "type": "project.configure",
  "binding_id": "binding-id",
  "binding_config_version": 7,
  "performer_binding_id": "performer-binding-id",
  "performer_binding_generation": 3,
  "performer_profile_id": "performer-profile-id",
  "runtime_profile_id": "runtime-profile-id",
  "performer_kind": "codex",
  "runtime_kind": "codex",
  "execution_policy": {},
  "execution_policy_sha256": "64-lowercase-hex",
  "turn_policy": {},
  "turn_policy_sha256": "64-lowercase-hex",
  "linear_project_id": "project-id",
  "repository": {"mode": "local_path", "value": "/repo"}
}
~~~

Conductor stores that current policy projection in instance linear_filters for
the existing binding-generation fence. It stores no config document, API host,
credential reference, slot, or Codex path.

Rename every report/ack comparison from config_sha256 and policy_sha256 to
execution_policy_sha256 and turn_policy_sha256. Keep stale generation,
repository, project, and binding mismatch behavior.

**Test-first steps**

- Make project.configure tests assert the exact policy-only key set.
- Add negative tests for old config/credential fields.
- Update Conductor apply/no-op/stale/report/ack tests for both policy hashes.
- Preserve hard-cut unbind/rebind behavior and managed-run snapshot redaction.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_podium_performer_profiles.py tests/test_podium_storage.py tests/test_conductor_podium_sync.py -q
~~~

**Acceptance**

- The command and runtime report contain Symphony policy only.
- An identical binding/generation/hash tuple remains idempotent.
- A stale generation or mismatched hash cannot replace local state.

### Phase 1 checkpoint

Run the combined focused suite above. Then:

~~~bash
mkdir -p .test/adr-0005
make test > .test/adr-0005/phase-1-make-test.log 2>&1
~~~

Inventory the full log, write phase-1-root-causes.md, repair by group, rerun the
combined focused suite, then rerun the exact make test command. Commit only
after both are green:

~~~bash
git add -A -- \
  packages/performer-api/src/performer_api/codex_runtime.py \
  packages/performer-api/src/performer_api/__init__.py \
  packages/podium/src/podium/performer_profiles.py \
  packages/podium/src/podium/podium_performer_profiles.py \
  packages/podium/src/podium/podium_project_bindings.py \
  packages/podium/src/podium/store/_postgres_schema_statements.py \
  packages/podium/src/podium/store/_postgres_profiles.py \
  packages/conductor/src/conductor/conductor_podium_sync.py \
  tests/test_performer_api_codex_runtime.py \
  tests/test_podium_performer_profiles.py \
  tests/test_podium_storage.py \
  tests/test_conductor_podium_sync.py \
  tasks/todo.md
git commit -m "refactor: hard-cut Codex-owned profile data"
~~~

---

## Phase 2: Establish the Performer backend boundary

### Task 4: Add provider-neutral shared turn and control contracts

**Dependencies**

- Phase 1 complete.

**Files**

- Create: packages/performer-api/src/performer_api/runtime_policy.py
- Create: packages/performer-api/src/performer_api/performer_control.py
- Modify or create: packages/performer-api/src/performer_api/performer_turns.py
- Modify: packages/performer-api/src/performer_api/__init__.py
- Remove after import migration: packages/performer-api/src/performer_api/codex_runtime.py
- Rename/replace: tests/test_performer_api_codex_runtime.py
- Create: tests/test_performer_api_control.py
- Modify callers that import the renamed policy/turn contracts.

**Implementation contract**

Move the already-approved Symphony `RuntimePolicy` and
`PerformerProfileConfig` out of Codex-named modules without changing their
Phase 1 policy semantics. Do not leave compatibility aliases.

Add closed, versioned shared contracts for:

- `PerformerTurnRequest` and `PerformerTurnResult`;
- `PerformerControlRequest`, `PerformerControlEvent`, and
  `PerformerControlResult`;
- `PerformerCapabilities`;
- `PerformerReadinessState`;
- `PerformerControlError`;
- normalized account, login challenge, configuration snapshot, and Check
  result variants.

Control request/result/event contracts contain no secret values. A request may
declare an expected secret-input kind and bounded length; the value is a
separate ephemeral pipe frame and is never serializable through these models.

The control operation union is exactly:

~~~text
performer.status
performer.login
performer.session.delete
performer.config.read
performer.config.write
performer.check
~~~

`PerformerCapabilities` declares backend kind/display label, protocol version,
turn kinds, logical login methods, session deletion, logical editable settings,
config-source visibility, and manual Check support.

Shared logical settings use provider-neutral names. The MVP may expose
`api_base_url`; the Codex adapter later maps it to `openai_base_url`.

Every contract is strict and bounded. Unknown operation, event, result, kind,
field, capability, oversized text, raw path, Base64 blob, secret field, or SDK
object fails closed. Errors have `error_code`, `sanitized_reason`,
`action_required`, `retryable`, optional `attempt_number`, and `next_action`.

Readiness identity includes backend kind, binding generation, execution-policy
hash, and capability/protocol version so evidence from another backend or
policy cannot authorize a turn.

**Test-first steps**

- Write exact round-trip and unknown-field tests for every discriminator.
- Add secret/path/oversize rejection cases.
- Prove Conductor-side tests can construct and validate every request/result
  without importing Performer or a provider SDK.
- Prove backend-kind, binding-generation, policy-hash, or capability-version
  mismatch invalidates readiness compatibility.
- Migrate imports and remove the Codex-named shared module only after all
  callers use the neutral contracts.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_performer_api_control.py tests/test_performer_api_runtime_policy.py tests/test_minimal_performer_api.py -q
~~~

**Acceptance**

- `performer_api` contains no provider SDK type or provider-specific control
  request.
- Conductor can use only these contracts for control and turn process I/O.
- The union is closed; arbitrary dictionaries cannot tunnel SDK payloads.
- No active import uses `performer_api.codex_runtime`.

### Task 5: Add the internal PerformerBackend interface and explicit registry

**Dependencies**

- Task 4.

**Files**

- Create: packages/performer/src/performer/backend_interface.py
- Create: packages/performer/src/performer/backend_registry.py
- Create or rename: packages/performer/src/performer/managed_turn.py
- Modify: packages/performer/src/performer/cli.py
- Create: tests/test_performer_backend_contract.py
- Modify: tests/test_minimal_performer_turn.py

**Implementation contract**

Define a Performer-internal Protocol or ABC with the semantic surface:

~~~python
class PerformerBackend(Protocol):
    @property
    def kind(self) -> str: ...

    def capabilities(self) -> PerformerCapabilities: ...

    async def control(
        self,
        request: PerformerControlRequest,
        secret_input: bytes | None,
    ) -> PerformerControlResult: ...

    async def run_turn(
        self,
        request: PerformerTurnRequest,
    ) -> PerformerTurnResult: ...
~~~

The exact implementation may split control and turn helpers, but the interface
is not exported to Conductor. Performer core continues to own Symphony
plan/execute/gate prompts, JSON schemas, workspace-change rules, wire
validation, runtime-wait normalization, and final result writing. A backend
owns SDK/CLI/provider differences only.

Add an explicit registry from approved `performer_kind` to backend factory.
There is no dynamic import, entry point, user plugin path, fallback provider,
or automatic backend substitution.

Codex is the first production registry entry. A deterministic fake backend is
available only through test injection and must exercise the same contract.
Do not add a placeholder production Claude adapter; its SDK/auth/config contract
requires separate approval.

**Test-first steps**

- Run the same capability/control/turn contract suite against a fake backend.
- Prove the registry selects an exact approved kind and rejects unknown kinds
  with `performer_backend_unsupported`.
- Prove the CLI reaches the backend only through the registry/interface.
- Preserve prompt/schema/workspace behavior outside the adapter.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_performer_backend_contract.py tests/test_minimal_performer_turn.py tests/test_performer_cli.py -q
~~~

**Acceptance**

- Performer core has no `_managed_codex_backend` special path.
- FakeBackend can complete turn/control tests without installing or mocking the
  Codex SDK.
- Registry failure is closed, generic, and visible.
- No backend interface or registry is placed in `performer_api`.

### Task 6: Move Codex turn execution behind CodexBackend

**Dependencies**

- Tasks 4 and 5.
- Safe to run in parallel with Task 8 on non-overlapping files.

**Files**

- Create: packages/performer/src/performer/backends/__init__.py
- Create: packages/performer/src/performer/backends/codex.py
- Modify: packages/performer/src/performer/codex_config.py
- Modify: packages/performer/src/performer/codex_client.py
- Modify: packages/performer/src/performer/codex_client_helpers.py
- Modify: packages/performer/src/performer/cli.py
- Modify: tests/test_performer_sdk_client.py
- Modify: tests/test_performer_cli.py
- Modify: tests/test_minimal_performer_turn.py

**Implementation contract**

Place all `openai_codex` imports, generated types, SDK construction, exception
classification, and policy mapping under Performer-owned Codex backend modules.
Only `packages/performer` retains `openai-codex==0.1.0b3`.

Preserve the correct part of the prior Task 4 work: every plan/execute/gate
request carries validated execution policy, and CodexBackend maps:

- model and model provider;
- approval mode;
- reasoning effort and summary;
- turn-kind sandbox;
- initialization and turn timeouts;
- initialization/overload attempt limits;
- cwd, ephemeral mode, and output schema;
- optional approved Codex binary.

Remove environment-driven policy overrides. The fixed process environment is
context only; policy comes from the fenced request.

CodexBackend must not read or write `auth.json` or `config.toml` directly. SDK
events, objects, exceptions, local paths, and raw response payloads are
normalized and sanitized before returning to Performer core.

**Test-first steps**

- Preserve parameter-by-parameter SDK mapping tests.
- Assert invalid policy fails before SDK invocation.
- Assert provider exceptions and runtime waits normalize to shared results.
- Assert SDK objects, paths, and raw payloads cannot enter result JSON.
- Add a dependency/import test proving Conductor and Podium do not contain or
  depend on `openai-codex`.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_performer_sdk_client.py tests/test_performer_cli.py tests/test_minimal_performer_turn.py tests/test_package_boundaries.py -q
~~~

**Acceptance**

- Plan/execute/gate policy mapping remains complete.
- Provider SDK imports are restricted to Performer backend implementation
  modules.
- Conductor has no provider SDK dependency or provider-generated type.
- No provider-owned file is directly parsed or mutated.

### Task 7: Add the long-running Performer control host and Codex control adapter

**Dependencies**

- Tasks 4 and 5.
- May proceed in parallel with Task 6 until shared `performer/cli.py`
  integration, which the primary agent owns.

**Files**

- Create: packages/performer/src/performer/control_host.py
- Extend: packages/performer/src/performer/backends/codex.py
- Modify: packages/performer/src/performer/cli.py
- Create: tests/test_performer_control_cli.py
- Extend: tests/test_performer_backend_contract.py
- Extend: tests/test_performer_sdk_client.py

**Implementation contract**

Add an installed `performer control` mode using a bounded framed stdin protocol
and NDJSON or equivalent closed stdout protocol:

~~~text
Conductor -> Performer stdin: closed metadata frame + optional secret frame
Performer -> Conductor stdout: closed event/result frames
Performer stderr: structured sanitized operator logs only
~~~

The control host owns the selected backend instance and any provider login
handle/task. It implements generic status, login, session deletion, config
read/write, and manual Check through the backend interface.

For CodexBackend only:

- device-code login maps to the official SDK device flow;
- API-key login maps to the official SDK login method;
- session deletion cancels pending login or logs out;
- logical `api_base_url` maps to the SDK's typed app-server config operation;
- source-format config is bounded, decoded, redacted, and path-free;
- Check starts a real structured read-only SDK turn with current policy.

API keys exist only in the separate stdin secret-frame memory and backend call
memory. They must not
appear in argv, environment variables, request/result files, stdout, stderr,
exceptions, reports, or filesystem scans.

A pending device login remains inside the control process. Starting it releases
the Conductor mutation exchange so status and cancel remain usable. While
pending, readiness is unchecked and config/Check/turn operations fail closed.
If the control host exits or Conductor restarts, the pending login becomes
`lost`; no SDK handle is reconstructed.

Every mutation returns normalized readiness `unchecked`. Login/config success
does not run Check automatically.

**Test-first steps**

- Start, inspect, and cancel a fake device login in one control process.
- Prove an API-key sentinel is absent from stdout, stderr, temp files, argv,
  environment snapshots, and exceptions.
- Prove malformed/unknown/mismatched frames fail with
  `performer_control_protocol_invalid`.
- Prove raw SDK fields, paths, Base64, and unknown keys cannot cross stdout.
- Prove control-host restart projects pending login as `lost` and readiness as
  unchecked.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_performer_control_cli.py tests/test_performer_backend_contract.py tests/test_performer_sdk_client.py -q
~~~

**Acceptance**

- Provider login/config/Check code exists only in Performer.
- A provider login handle never enters Conductor memory or state.
- Secret-bearing controls leave no durable request/result artifact.
- Status/cancel work while a device login is pending.

### Task 8: Replace CodexController with a generic Conductor PerformerCoordinator

**Dependencies**

- Task 4.
- May proceed in parallel with Tasks 5-7 against a fake control process; final
  integration waits for Task 7.

**Files**

- Create: packages/conductor/src/conductor/performer_control.py
- Modify: packages/conductor/src/conductor/store.py
- Modify: packages/conductor/src/conductor/conductor_service.py
- Modify: packages/conductor/src/conductor/conductor_cli.py
- Modify: packages/conductor/pyproject.toml
- Delete: packages/conductor/src/conductor/codex.py
- Delete: tests/test_conductor_codex.py
- Create: tests/test_conductor_performer_control.py
- Modify: tests/test_conductor_workflow.py

**Implementation contract**

Remove the uncommitted wrong-direction `CodexController` implementation and the
Conductor `openai-codex` dependency. Do not port its SDK calls into another
Conductor module.

`PerformerCoordinator` owns only:

- starting, supervising, and stopping the installed control process;
- encoding/decoding `performer_api` control frames;
- generic async request correlation, timeout, cancellation, and process-exit
  handling;
- a generic exclusivity policy for mutation, Check, and complete turn
  subprocesses;
- status/cancel access while device login is pending;
- durable generic readiness and sanitized control failures.

Use asynchronous subprocess APIs. Never hold the event loop inside synchronous
`subprocess.run`; dispatch/lease heartbeats, log heartbeats, status, and cancel
must remain alive.

Create one SQLite row:

~~~text
performer_control_state
  id = 1
  performer_kind
  binding_generation
  capability_version
  execution_policy_sha256
  status = unchecked | checking | ready | failed
  last_check_status
  last_check_started_at
  last_check_finished_at
  error_code
  sanitized_reason
  action_required
  retryable
  next_action
  updated_at
~~~

Startup resets current readiness to unchecked but preserves the last sanitized
outcome. Backend kind, binding generation, capability version, or policy hash
mismatch also invalidates readiness. A control-host exit records a visible
generic failure and changes a pending login to lost.

**Test-first steps**

- Drive every control operation through a fake installed Performer process.
- Prove Conductor imports only `performer_api`.
- Prove mutation invalidates readiness before secret input is sent.
- Prove busy/status/cancel semantics without blocking the event loop.
- Prove process crash, timeout, malformed protocol, and stale reply are visible
  in SQLite, API view, and structured logs.
- Prove startup and identity mismatch reset readiness safely.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_conductor_performer_control.py tests/test_conductor_workflow.py tests/test_package_boundaries.py -q
~~~

**Acceptance**

- `packages/conductor` and its dependency manifest contain no provider SDK.
- There is no provider-specific controller in Conductor.
- All control I/O is validated through `performer_api`.
- Scheduler and lease heartbeats remain responsive during long control work.

### Task 9: Use one fixed backend context and remove slots/materialization

**Dependencies**

- Tasks 5-8.

**Files**

- Modify: packages/conductor/src/conductor/runtime.py
- Modify: packages/conductor/src/conductor/conductor_cli.py
- Modify: packages/conductor/src/conductor/conductor_service.py
- Modify: packages/conductor/src/conductor/workflow_driver.py
- Modify: packages/conductor/src/conductor/store.py
- Delete: packages/conductor/src/conductor/performer_credentials.py
- Delete: tests/test_conductor_performer_credentials.py
- Modify: tests/test_conductor_runtime.py
- Modify: tests/test_workflow_driver.py
- Modify: tests/test_conductor_workflow.py

**Implementation contract**

Construct one immutable allowlisted process environment at Conductor startup and
pass it to both the control host and every turn subprocess. It may include
`HOME`, optional provider-owned home variables such as `CODEX_HOME`, PATH,
locale/temp variables, and an approved backend binary. It excludes Podium,
Linear, browser, proxy, unrelated secret, and policy-override variables.

Conductor does not interpret provider files or expose per-call environment
overrides. Remove:

- PerformerCredentialSlots and credential CLI behavior;
- per-attempt provider-home materialization;
- provider TOML writing/parsing;
- auth copy-back/reconciliation;
- `codex_home` run arguments and hidden environment fallback;
- duplicate environment sources in runtime and controller code.

Every turn request carries `performer_kind`, binding identity, execution policy,
and policy hashes. `PerformerCoordinator` holds the generic turn exclusion for
the full asynchronous Performer process lifetime, except the explicitly allowed
status/cancel observations during a pending device login.

**Test-first steps**

- Assert the exact fixed environment allowlist and immutability.
- Assert Podium/Linear/config-override variables are absent.
- Assert no provider file is copied or parsed.
- Assert control and turn processes receive the same context.
- Assert slots and materialization callers reach zero before deletion.
- Preserve fencing, result collection, logs, timeout policy, and runtime-wait
  behavior.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_conductor_runtime.py tests/test_workflow_driver.py tests/test_conductor_workflow.py tests/test_conductor_performer_control.py -q
~~~

**Acceptance**

- No production path copies or reconciles provider credential/config files.
- There is one immutable environment source.
- Control and turn processes use the same fixed backend context.
- Existing fenced result behavior remains unchanged.

### Task 10: Gate and resume managed runs on generic Performer readiness

**Dependencies**

- Tasks 8 and 9.

**Files**

- Modify: packages/conductor/src/conductor/store.py
- Modify: packages/conductor/src/conductor/workflow_driver.py
- Modify: packages/conductor/src/conductor/conductor_podium_sync.py
- Modify: tests/test_conductor_workflow.py
- Modify: tests/test_workflow_driver.py
- Modify: tests/test_conductor_podium_sync.py
- Modify: tests/test_conductor_observability.py, if present.

**Implementation contract**

Before creating a plan, execute, or gate attempt, require compatible
`performer_control_state.status=ready`. A non-ready result does not create a
Performer attempt. It records one durable readiness block with:

~~~text
prior_phase
performer_kind
binding_generation
execution_policy_sha256
error_code
sanitized_reason
action_required
retryable
next_action
~~~

Use generic errors such as:

~~~text
performer_authentication_required
performer_check_required
performer_check_failed
performer_control_unavailable
performer_busy
performer_backend_setup_failed
~~~

Use stable events such as
`managed_run_performer_blocked` and `managed_run_performer_resumed`.

The same code/reason/action appears in SQLite, structured logs, Podium
managed-runs/report, and Linear. When manual Check passes for the same identity,
clear only the readiness block and resume the exact prior phase with a fresh
fence. Preserve gate rework, duplicate/stale results, runtime waits, and
operator-controlled Linear resumes.

**Test-first steps**

- Cover planning, executing, and gating readiness blocks.
- Prove no attempt/process starts while non-ready.
- Prove Check success resumes exact prior phase and creates a new fence.
- Prove stale Check evidence cannot resume another backend/binding/policy.
- Assert log/state/report/Linear parity for each failure path.
- Preserve all existing duplicate, stale, gate, and runtime-wait tests.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_conductor_workflow.py tests/test_workflow_driver.py tests/test_conductor_podium_sync.py tests/test_conductor_performer_control.py -q
~~~

**Acceptance**

- A non-ready turn never starts.
- A successful compatible Check resumes exactly once.
- Failure visibility is identical across operator surfaces.
- No readiness state or error name contains provider-controller vocabulary.

### Phase 2 checkpoint

Run the combined Phase 2 focused suite. Then:

~~~bash
mkdir -p .test/adr-0006
make test > .test/adr-0006/phase-2-make-test.log 2>&1
~~~

Inventory all failures, write
`.test/adr-0006/phase-2-root-causes.md`, repair by root-cause group, rerun the
focused suite, and rerun the exact full command. Before committing, run:

~~~bash
rg -n "openai[_-]codex|AsyncCodex|CodexController" packages/conductor
rg -n "codex_control_state|performer_codex\\." packages tests tools docs tasks
rg -n "performer_credentials|PerformerCredentialSlots" packages tests tools
git diff --check
~~~

The first command must return zero. The other searches may match historical
ADRs only where they explicitly describe superseded designs.

Commit the green corrected boundary as one reviewed phase checkpoint; use
explicit pathspecs and do not stage unrelated worktree changes.

---

## Phase 3: Expose provider-neutral live control and capability-driven Web UI

### Task 11: Replace credential routes with the provider-neutral Performer live API

**Dependencies**

- Phase 2 checkpoint.

**Files**

- Create: packages/podium/src/podium/podium_routes_performer_control.py
- Modify: packages/podium/src/podium/live_conductor_relay.py
- Modify: packages/podium/src/podium/app.py
- Modify: packages/conductor/src/conductor/conductor_api.py
- Create: tests/test_podium_performer_control.py
- Modify: tests/test_conductor_api.py
- Delete after callers reach zero:
  packages/podium/src/podium/podium_routes_live_credentials.py
- Delete after callers reach zero: tests/test_podium_live_credentials.py

**Implementation contract**

Use generic live operations:

~~~text
performer.status
performer.login
performer.session.delete
performer.config.read
performer.config.write
performer.check
~~~

Expose owner-authorized no-store BFF routes:

~~~text
GET    /api/v1/conductors/{id}/performer
POST   /api/v1/conductors/{id}/performer/login
DELETE /api/v1/conductors/{id}/performer/session
GET    /api/v1/conductors/{id}/performer/config
PATCH  /api/v1/conductors/{id}/performer/config
POST   /api/v1/conductors/{id}/performer/check
~~~

Podium uses only the in-memory live relay for these operations. API keys and
device-login material must not enter PostgreSQL runtime commands, retry queues,
reports, log tails, or background jobs.

Preserve ownership checks, online presence, lease/reply fencing, deadlines,
duplicate/stale reply rejection, operation-specific normalization, and Check
rate limiting. Status returns backend kind and capabilities; Podium never
infers backend abilities from `performer_kind`.

Reject unknown request/result fields, raw SDK data, paths, Base64, secret-like
keys, unsupported logical settings, and operation/result mismatches.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_podium_performer_control.py tests/test_conductor_api.py tests/test_conductor_performer_control.py -q
~~~

**Acceptance**

- Live route and operation names are provider-neutral.
- API-key material exists only in request/relay/pipe memory.
- Podium persists no live provider control fact.
- Capability and result validation fail closed.

### Task 12: Add generic Web contracts and non-cached transient control state

**Dependencies**

- Task 11 route/response contract frozen.
- May proceed in parallel with backend route implementation once the contract is
  frozen.

**Files**

- Modify: packages/podium/web/src/lib/types.ts
- Modify: packages/podium/web/src/lib/client.ts
- Modify: packages/podium/web/src/lib/hooks.ts
- Modify: packages/podium/web/src/lib/client.test.ts
- Add focused hook tests where existing test layout requires them.

**Implementation contract**

Add closed Web types named around Performer concepts:

- `PerformerStatus`;
- `PerformerCapabilities`;
- `PerformerLoginMethod` and `AuthenticationChallenge`;
- `PerformerConfigurationSnapshot`;
- `PerformerCheckState`;
- operation-specific request/result/error variants.

Do not place API keys, device user codes, config source, or login results in
TanStack Query data or mutation-variable caches. Secret inputs use a transient
callback/fetch path whose retained variables never contain the secret after the
request begins. Device challenge and config source stay in drawer-local state
and are cleared on close/unmount.

All responses are treated as untrusted and parsed against closed types.

**Focused verification**

~~~bash
cd packages/podium/web
npm run test -- --run src/lib/client.test.ts
npm run lint
~~~

**Acceptance**

- No cache contains API-key/device/config-source material.
- Unknown backend/control payloads fail closed.
- Closing/unmounting clears transient state.
- Web types contain no SDK-generated shape.

### Task 13: Add a capability-driven Performer control drawer

**Dependencies**

- Task 12.

**Files**

- Create: packages/podium/web/src/pages/RuntimesPerformerDrawer.tsx
- Create: packages/podium/web/src/pages/RuntimesPerformerDrawer.test.tsx
- Create: packages/podium/web/src/styles/performer-control.css
- Modify: packages/podium/web/src/pages/RuntimesPage.tsx
- Modify: packages/podium/web/src/styles/index.css
- Modify DESIGN.md/tokens only if an actually required value is missing.

**Implementation contract**

Read `packages/podium/web/DESIGN.md` before editing. The drawer is attached to a
Conductor and titled as a Performer control surface. It may display the selected
backend's capability-provided label, including Codex, but its component, API,
state, and CSS names remain provider-neutral.

Render only capabilities declared by `PerformerCapabilities`:

- supported login methods;
- pending challenge and cancel/session deletion;
- supported logical config fields;
- optional redacted config source;
- explicit manual Check;
- current and last readiness evidence.

Unsupported controls are hidden or shown as explicitly unsupported; do not add
provider branches in Podium or Conductor. Login/config success leaves readiness
unchecked. The UI never starts Check automatically. API-key input is cleared
before awaiting completion.

**Focused verification**

~~~bash
cd packages/podium/web
npm run test -- --run src/pages/RuntimesPerformerDrawer.test.tsx
npm run test
npm run lint
npm run design:lint
npm run build
~~~

**Acceptance**

- One drawer adapts to capabilities without provider controller code.
- Secret/transient state is cleared and never cached.
- Mutations do not trigger Check.
- Test/lint/design-lint/build are clean.

### Phase 3 checkpoint

Run the complete Phase 3 Python and Web focused suites, then:

~~~bash
make test > .test/adr-0006/phase-3-make-test.log 2>&1
~~~

Inventory every failure in
`.test/adr-0006/phase-3-root-causes.md`, repair by group, rerun focused suites
and the full suite, then commit the green provider-neutral live surface with
explicit pathspecs.

---

## Phase 4: Rewrite real E2E, reconcile active docs, and close MVP

### Task 14: Run Check and turns only through installed Performer processes

**Dependencies**

- Phase 3 checkpoint.

**Files**

- Modify: tools/real_flow.py
- Modify: focused real-flow helper modules already used by that runner.
- Modify: tests/test_real_flow.py and existing diagnostic tests.
- Do not create a second E2E runner.

**Implementation contract**

The Performer diagnostic:

1. stages one isolated per-batch backend context from the approved fixed seed;
2. starts the installed `performer control` process;
3. obtains status/capabilities through the generic control contract;
4. runs one manual real Check through that process;
5. runs real plan, execute, and gate through installed Performer turn commands;
6. uses the same staged context for control and turns;
7. stops the control host and archives sanitized artifacts.

`tools/real_flow.py` must not import a provider SDK, instantiate
`CodexController`, parse provider TOML/auth files, or copy credentials per
attempt. It may select the Codex backend and canonical `gpt-5.4` execution
policy for the approved real diagnostic.

Keep OAuth, Linear, Performer, and Overall reports mutually independent but
under one run id. Preserve immediate failure emission, stale fencing probes,
duplicate-result checks, secret/path scans, and required log/state artifact
collection.

**Focused verification**

~~~bash
PYTHONPATH=$(pwd)/packages/performer-api/src:$(pwd)/packages/performer/src:$(pwd)/packages/conductor/src:$(pwd)/packages/podium/src \
  .venv/bin/python -m pytest tests/test_real_flow.py -q
~~~

**Acceptance**

- The runner crosses only the installed Performer process boundary.
- Check and turns share one staged context.
- No provider SDK/provider file parser exists in the runner.
- Secret-bearing control artifacts are absent.

### Task 15: Reconcile active architecture, module, security, and real-flow docs

**Dependencies**

- Task 14 implementation shape stable.

**Files**

- Modify: README.md
- Modify: AGENT.md and AGENTS.md
- Modify: docs/modules/performer-api.md
- Modify: docs/modules/performer.md
- Modify: docs/modules/conductor.md
- Modify: docs/modules/verification.md
- Modify: docs/product/security-model.md
- Modify: docs/real-flow.md
- Modify: docs/real-e2e-design.md
- Keep historical ADR-0004/0005 text except their supersession status.

**Implementation contract**

Active docs must state:

- Conductor imports only `performer_api` and starts installed Performer
  control/turn processes;
- Performer owns the backend interface/registry and provider SDK adapters;
- provider SDK/auth/config/Check/handles may exist only in Performer backend
  implementations;
- control routes/operations/readiness/errors are provider-neutral;
- Codex is the first production adapter, not a Conductor dependency;
- the real runner uses one staged per-batch context and installed Performer;
- a production Claude adapter remains separately unspecified.

Remove active claims about Conductor `CodexController`, per-attempt homes,
credential slots, Podium provider TOML, or provider SDK calls in Conductor.
Historical ADR rationale remains visible and explicitly superseded.

**Verification**

~~~bash
rg -n "CodexController|codex_control_state|performer_codex\\." README.md AGENT.md AGENTS.md docs/product docs/modules docs/real-flow.md docs/real-e2e-design.md tasks
rg -n "openai[_-]codex|AsyncCodex" packages/conductor README.md AGENT.md AGENTS.md docs/product docs/modules tasks
git diff --check
~~~

Only historical ADR descriptions and explicit negative guardrails may match.

**Acceptance**

- Active documentation has one ownership model.
- Agent rules make boundary violations build-blocking defects.
- Real-flow instructions match the installed Performer boundary.

### Phase 4 local checkpoint

Run Task 14 focused tests, all documentation searches, `git diff --check`, and
one complete `make test`. Record all failures in
`.test/adr-0006/phase-4-root-causes.md`, repair by group, and rerun before any
external diagnostic.

### Task 16: Run the three diagnostics as one failure-collection batch

**Dependencies**

- Phase 4 local checkpoint green.
- Required staged environment and approved Codex seed available.

Run OAuth, Linear, and Performer diagnostics consecutively with no code fix
between them. Record every check and artifact path under one batch id. Group the
complete failure set by root cause across:

- OAuth callback/install/token health;
- Linear fixture/schema/binding/polling/projection;
- Performer control protocol/capabilities/readiness;
- CodexBackend account/provider/policy/Check/turn execution;
- Conductor process/lease/readiness/log visibility;
- secret/path/artifact scans.

Repair root-cause groups only after the whole batch is collected. Then rerun
local focused tests plus `make test`, followed by all three diagnostics as a new
batch.

**Acceptance**

- All three prerequisite reports pass in the same batch.
- A failure in one phase does not masquerade as another phase's success.
- Provider/backend failures are immediately visible with generic outer error
  codes and safe adapter summaries.
- Reports link Podium, Conductor, Performer, request/result, managed-runs, and
  Linear evidence.

### Task 17: Run final all-phase acceptance and review

**Dependencies**

- Task 16 all green.

Run:

~~~bash
set -a && source .env && set +a
PYTHONPATH=tools .venv/bin/python tools/real_flow.py \
  --phase all \
  --project-slug "$SYMPHONY_E2E_PROJECT_SLUG" \
  --out .test-real-flow/batch-report.json
~~~

Then run:

~~~bash
git diff --check
make test
cd packages/podium/web && npm run test
cd packages/podium/web && npm run lint
cd packages/podium/web && npm run design:lint
cd packages/podium/web && npm run build
~~~

Perform code-quality, security, import-boundary, and scope-ledger review. The
final evidence must prove:

- one real successful parent/task/Gate closure;
- first Gate failure reworks and second failure blocks;
- duplicate and stale results do not advance state;
- manual Check gates plan/execute/gate through Performer;
- Conductor has no provider SDK dependency;
- control secrets do not persist;
- capability-driven API/UI behavior;
- the same sanitized readiness/backend failure across SQLite, logs, Podium, and
  Linear;
- one final run id links OAuth, Linear, Performer, and Overall evidence.

Commit only after every accepted requirement has fresh evidence and the
worktree contains no unrelated staged change.

---

## Definition of done

1. `performer_api` exposes strict provider-neutral turn/control/capability/
   readiness contracts.
2. Performer owns the internal backend interface, explicit registry, and every
   provider SDK integration.
3. CodexBackend is the first production implementation; no unapproved Claude
   SDK/auth/config contract is invented.
4. Conductor imports only `performer_api`, launches installed Performer
   processes, and contains no provider SDK/controller.
5. Secret-bearing control operations use pipes and leave no durable artifact.
6. One fixed backend context is shared by control and turns; no production
   per-attempt provider-home copy or credential slot remains.
7. Manual compatible Check is the only transition to ready; non-ready turns
   block visibly and resume exactly once.
8. Podium live routes/operations and Web state are provider-neutral and
   capability-driven.
9. Existing workflow, Gate, fencing, wait, logging, Linear, OAuth, and Web
   behavior remains green.
10. Focused suites, `make test`, Web test/lint/design-lint/build, real
    diagnostics, final all-phase flow, code review, and security review provide
    evidence-backed acceptance.
