const REQUIRED = Object.freeze([
  ["runner_production_owner", "runner", /createProductionPodiumConductorOwner/u],
  ["runner_conductor_harness", "runner", /startConductorHarness/u],
  ["runner_profile_boundary", "runner", /provisionApiKeyProfile/u],
  ["runner_human_boundary", "runner", /createHumanActor/u],
  ["runner_monitor", "runner", /createCoreLiveMonitor/u],
  ["runner_deadline_checks", "runner", /monitor\.checkDeadlines/u],
  ["runner_git_evidence", "runner", /readRootGitEvidence/u],
  ["runner_root_evidence", "runner", /createRootCompletionEvidence/u],
  ["runner_root_evidence_step", "runner", /root_completion_evidence/u],
  ["runner_broker_root_facts", "runner", /rootFacts: brokerRootFacts/u],
  ["runner_run_deadline", "runner", /DEFAULT_RUN_TIMEOUT_MS = 25 \* 60_000/u],
  ["runner_fallback_poll", "runner", /pollIntervalMs = 5_000/u],
  ["runner_batched_readback", "runner", /readRootStates\(linear, fixtures, monitor\)/u],
  ["fixture_root_input", "fixtures", /async createRoot\(/u],
  ["fixture_batched_state", "fixtures", /async readRunStates\(/u],
  ["fixture_exact_description", "fixtures", /description: rootInstruction/u],
  ["monitor_monotonic_phases", "monitor", /e2e_root_phase_regression/u],
  ["monitor_turn_watchdog", "monitor", /e2e_root_progress_stalled/u],
  ["monitor_heartbeat", "monitor", /e2e_monitor_heartbeat/u],
  ["git_diff_readback", "gitEvidence", /--name-only/u],
  ["git_status_readback", "gitEvidence", /--porcelain=v1/u],
  ["git_commit_readback", "gitEvidence", /rev-list.*--count/su],
  ["git_common_dir_readback", "gitEvidence", /commonGitDirValid/u],
  ["conductor_workspace_event", "conductor", /workspace_ready/u],
  ["conductor_turn_event", "conductor", /performer_turn_event/u],
  ["conductor_broker_event", "conductor", /agent_broker_result/u],
  ["conductor_bounded_shutdown", "conductor", /cancelAndReap/u],
  ["conductor_initial_poll", "conductor", /while \(!stopping\) \{\s+const disposition = await runtime\.cycle\(\);/su],
]);

export function auditCoreLiveSources(sources = {}) {
  const failures = [];
  for (const [code, sourceName, pattern] of REQUIRED) {
    if (typeof sources[sourceName] !== "string" || !pattern.test(sources[sourceName])) {
      failures.push(code);
    }
  }

  const runner = typeof sources.runner === "string" ? sources.runner : "";
  const monitor = typeof sources.monitor === "string" ? sources.monitor : "";
  const gitEvidence = typeof sources.gitEvidence === "string" ? sources.gitEvidence : "";
  if (/\b(seedPlan|completeRoot|createBlockerRelation|updateRootScheduling|approvePlan)\b/u.test(runner) ||
      /(?:git\.commit|root\.deliver)\(\s*/u.test(runner)) {
    failures.push("runner_forbidden_workflow_helper");
  }
  if (/SYMPHONY_E2E_LINEAR_DEV_TOKEN|SYMPHONY_CODEX_API_KEY/u.test(runner) ||
      /worktreePath/u.test(monitor) || /worktreePath/u.test(gitEvidence)) {
    failures.push("secret_or_path_leak_boundary");
  }
  const rootInputOffset = runner.indexOf("fixtures.push(await linear.createRoot");
  const conductorStartupOffset = runner.indexOf("harness = await startConductorHarness");
  if (rootInputOffset < 0 || conductorStartupOffset < 0 ||
      rootInputOffset > conductorStartupOffset) {
    failures.push("runner_root_inputs_before_conductor");
  }
  return Object.freeze({ passed: failures.length === 0, failures: Object.freeze([...failures]) });
}
