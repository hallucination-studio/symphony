# ADR-0006 Performer Backend Boundary Checklist

Status: approved implementation plan. Phase 1 is retained completed history;
the former Conductor CodexController direction is superseded and must not be
continued. Detailed contracts and commands are in `tasks/plan.md`.

## Non-negotiable execution rule

- [ ] For each new phase: finish the coherent change, run focused tests, run
      one complete `make test`, inventory every failure, group by root cause,
      repair groups, then rerun focused tests and `make test`.
- [ ] Do not repair and rerun one failing test at a time.
- [ ] Keep `.test/adr-0006/phase-N-make-test.log` and
      `phase-N-root-causes.md` for every new phase.
- [ ] Keep `assumptions_requiring_approval` empty before production edits.
- [ ] Freeze `performer_api` contracts before parallel implementation lanes.
- [ ] Keep shared integration files owned by the primary agent.

## Phase 1: Policy/profile hard cut — completed history

- [x] Replace shared Codex TOML/config documents with `RuntimePolicy` and
      policy-only `PerformerProfileConfig`.
- [x] Reject Codex-owned config, credential, slot, path, and legacy revision
      fields at the shared boundary.
- [x] Replace Podium `runtime.toml` ingestion with execution/turn policy JSON.
- [x] Rename PostgreSQL profile columns/hashes while preserving mutable rows,
      bindings, generation fencing, and no revision tables.
- [x] Change `project.configure`, Conductor projection, reports, and acks to
      policy documents/hashes only.
- [x] Commit the Phase 1 checkpoint as `e3b5b09`.

## Phase 2: Performer backend boundary — completed checkpoint

- [x] Add provider-neutral turn/control/capability/readiness contracts in
      `performer_api`; remove active Codex-named shared modules without aliases.
- [x] Add internal `PerformerBackend` Protocol/ABC and explicit closed registry.
- [x] Prove a deterministic test backend satisfies the same contract without a
      provider SDK.
- [x] Move all Codex turn SDK imports, types, policy mapping, errors, and result
      normalization behind `CodexBackend`.
- [x] Add long-running `performer control` framed stdin/stdout protocol.
- [x] Keep device-login handles and provider sessions inside the Performer
      control process; keep status/cancel usable while login is pending.
- [x] Keep API keys only in request/relay/pipe/process memory with no durable
      request/result, argv, environment, stdout, stderr, or log artifact.
- [x] Replace the wrong-direction Conductor `CodexController` with generic
      `PerformerCoordinator` using only `performer_api`.
- [x] Remove `openai-codex` and provider-generated types from Conductor.
- [x] Add one generic secret-free `performer_control_state` row with backend,
      binding, capability, policy, readiness, and sanitized Check identity.
- [x] Make Conductor control/turn process handling asynchronous so scheduler,
      lease/log heartbeats, status, and cancel remain responsive.
- [x] Use one immutable allowlisted environment for control and turn processes.
- [x] Remove credential slots, per-attempt provider-home materialization, TOML
      writing/parsing, auth copy-back, and duplicate environment sources.
- [x] Block non-ready plan/execute/gate turns visibly and resume their exact
      prior phase only after a compatible manual Check.
- [x] Prove the same generic sanitized failure in SQLite, logs, Podium
      managed-runs/report, and Linear.
- [x] Run Phase 2 focused tests, full failure collection, grouped repair, full
      rerun, boundary searches, and green checkpoint commit.

## Phase 3: Provider-neutral Podium live API and Web — completed checkpoint

- [x] Replace credential/Codex-specific live operations with
      `performer.status`, `performer.login`, `performer.session.delete`,
      `performer.config.read`, `performer.config.write`, and `performer.check`.
- [x] Add owner-only no-store `/conductors/{id}/performer/*` routes while
      preserving live relay fencing, deadlines, duplicate/stale rejection, and
      Check rate limiting.
- [x] Return backend kind plus closed capabilities; Podium must not infer
      provider support or pass raw SDK/path/Base64/unknown fields.
- [x] Keep API keys and device-login material out of PostgreSQL commands,
      retries, reports, logs, and background jobs.
- [x] Add generic Web contracts and transient non-cached secret/config/login
      state.
- [x] Add `RuntimesPerformerDrawer` rendered from capabilities, not provider
      branches; backend branding may be display data only.
- [x] Prove login/config mutations never trigger Check automatically and API
      key/transient state is cleared before completion or on close.
- [x] Run Web test/lint/design-lint/build, Phase 3 focused Python tests, full
      failure collection, grouped repair, full rerun, and green checkpoint.

## Phase 4: Real E2E and active docs

- [x] Rewrite the Performer diagnostic to start installed `performer control`,
      obtain capabilities, run manual Check, and run plan/execute/gate through
      installed Performer turn commands.
- [x] Share one approved staged per-batch provider context across control and
      turns; never import provider SDKs or parse provider auth/config in tools.
- [x] Retain stale fencing, duplicate-result, immediate failure, secret/path,
      and required-artifact checks.
- [x] Reconcile README, agent rules, module/security docs, real-flow docs, and
      real-E2E design with ADR-0006 while preserving historical ADR rationale.
- [x] Run Phase 4 focused tests, documentation searches, `git diff --check`,
      full failure collection, grouped repair, and full rerun.
- [ ] Run OAuth, Linear, and Performer diagnostics consecutively with no fixes
      between them; collect and group the complete failure set.
- [ ] Repair diagnostic root-cause groups, rerun local focused plus full tests,
      then rerun all diagnostics as one batch.
- [ ] After all prerequisites pass, run one final `tools/real_flow.py --phase all`.

## Final acceptance

- [ ] One real successful parent/task/Gate closure.
- [ ] First Gate failure reworks; second failure blocks task and parent.
- [ ] Duplicate results do not advance state twice.
- [ ] Stale results do not change the current task.
- [ ] Manual compatible Check gates plan/execute/gate through Performer.
- [ ] Conductor has no provider SDK dependency, provider controller, or
      provider-generated type.
- [ ] Control secrets leave no durable request/result/cache/log/report artifact.
- [ ] Capability-driven API/UI works without provider branches in Conductor or
      Podium.
- [ ] Runtime waits, failures, browser responses, reports, and logs contain no
      secrets or private provider paths.
- [ ] Real OAuth, Linear, manual Check, and CodexBackend plan/execute/gate
      complete under one final run id.
- [ ] `git diff --check`, `make test`, Web test/lint/design-lint/build, code
      review, import-boundary review, and security review are green.
- [ ] Every MVP requirement has evidence-backed 4/4 acceptance and an artifact
      or report path.
