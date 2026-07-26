export const MANDATORY_FOREGROUND_CASE_IDS = Object.freeze([
  "approved_happy_path",
  "plan_rejected_and_replanned",
  "information_requested_and_answered",
  "root_revision_and_comment",
  "parallel_multi_conductor",
  "same_conductor_preemption",
  "conductor_restart_recovery",
]);

export const RETIRED_WORKFLOW_E2E_INVENTORY = Object.freeze([
  entry("tests/e2e/approved-happy-path-evidence.test.mjs", "case assertions"),
  entry("tests/e2e/approved-happy-path-fixture.mjs", "case assertions"),
  entry("tests/e2e/campaign-command.test.mjs", "campaign"),
  entry("tests/e2e/conductor-harness.test.mjs", "environment"),
  entry("tests/e2e/configured-campaign-runner.test.mjs", "campaign"),
  entry("tests/e2e/cycle-successor-evidence.test.mjs", "case assertions"),
  entry("tests/e2e/cycle-successor-fixture.mjs", "case assertions"),
  entry("tests/e2e/desktop-shell-config.test.mjs", "Desktop smoke outside workflow E2E"),
  entry("tests/e2e/external-linear-actor.test.mjs", "human"),
  entry("tests/e2e/fresh-evidence-reader.test.mjs", "evidence"),
  entry("tests/e2e/logging.test.mjs", "reporter"),
  entry("tests/e2e/parallel-black-box-cli.test.mjs", "campaign"),
  entry("tests/e2e/parallel-black-box-control-plane.test.mjs", "environment"),
  entry("tests/e2e/parallel-black-box-runtime.test.mjs", "environment"),
  entry("tests/e2e/parallel-repository-pool.test.mjs", "environment"),
  entry("tests/e2e/plan-rejection-supersession-evidence.test.mjs", "case assertions"),
  entry("tests/e2e/plan-rejection-supersession-fixture.mjs", "case assertions"),
  entry("tests/e2e/podium-client-owner.test.mjs", "environment"),
  entry("tests/e2e/podium-control-plane.test.mjs", "environment"),
  entry("tests/e2e/podium-process-host.test.mjs", "environment"),
  entry("tests/e2e/podium-production-starter.test.mjs", "environment"),
  entry("tests/e2e/production-negative-controls.test.mjs", "architecture guards"),
  entry("tests/e2e/public-campaign-ports.test.mjs", "environment"),
  entry("tests/e2e/required-write-evidence.test.mjs", "removed"),
  entry("tests/e2e/required-write-outage-fixture.mjs", "removed"),
  entry("tests/e2e/required-write-outage.test.mjs", "removed"),
  entry("tests/e2e/restart-isolation-evidence.test.mjs", "case assertions"),
  entry("tests/e2e/restart-isolation-fixture.mjs", "case assertions"),
  entry("tests/e2e/root-revision-comment-evidence.test.mjs", "case assertions"),
  entry("tests/e2e/root-revision-comment-fixture.mjs", "case assertions"),
  entry("tests/e2e/run-with-timeout.test.mjs", "campaign"),
  entry("tests/e2e/same-conductor-preemption-evidence.test.mjs", "case assertions"),
  entry("tests/e2e/same-conductor-preemption-fixture.mjs", "case assertions"),
  entry("tests/e2e/target-architecture-runner.test.mjs", "campaign"),
  entry("tools/e2e/approved-happy-path-evidence.mjs", "case assertions"),
  entry("tools/e2e/conductor-harness.mjs", "environment"),
  entry("tools/e2e/config.mjs", "campaign"),
  entry("tools/e2e/cycle-successor-evidence.mjs", "case assertions"),
  entry("tools/e2e/delivery-review-evidence.mjs", "case assertions"),
  entry("tools/e2e/desktop-shell-build.mjs", "Desktop smoke outside workflow E2E"),
  entry("tools/e2e/desktop-shell-environment.mjs", "Desktop smoke outside workflow E2E"),
  entry("tools/e2e/desktop-shell-smoke.mjs", "Desktop smoke outside workflow E2E"),
  entry("tools/e2e/desktop-shell-verdict.mjs", "Desktop smoke outside workflow E2E"),
  entry("tools/e2e/external-linear-actor.mjs", "human"),
  entry("tools/e2e/final-evidence-verdict.mjs", "verdict"),
  entry("tools/e2e/fresh-evidence-reader.mjs", "evidence"),
  entry("tools/e2e/human-scripts.mjs", "human"),
  entry("tools/e2e/logging.mjs", "reporter"),
  entry("tools/e2e/parallel-black-box-cli.mjs", "campaign"),
  entry("tools/e2e/parallel-black-box-contract.mjs", "immutable cases"),
  entry("tools/e2e/parallel-black-box-control-plane.mjs", "environment"),
  entry("tools/e2e/parallel-black-box-runtime.mjs", "environment"),
  entry("tools/e2e/parallel-repository-pool.mjs", "environment"),
  entry("tools/e2e/plan-rejection-supersession-evidence.mjs", "case assertions"),
  entry("tools/e2e/podium-client-owner.mjs", "environment"),
  entry("tools/e2e/podium-control-plane.mjs", "environment"),
  entry("tools/e2e/podium-process-host.mjs", "environment"),
  entry("tools/e2e/podium-production-starter.mjs", "environment"),
  entry("tools/e2e/public-campaign-ports.mjs", "removed"),
  entry("tools/e2e/required-write-evidence.mjs", "removed"),
  entry("tools/e2e/required-write-outage.mjs", "removed"),
  entry("tools/e2e/restart-isolation-evidence.mjs", "case assertions"),
  entry("tools/e2e/root-revision-comment-evidence.mjs", "case assertions"),
  entry("tools/e2e/run-parallel-black-box-campaign.mjs", "campaign"),
  entry("tools/e2e/run-with-timeout.mjs", "campaign"),
  entry("tools/e2e/same-conductor-preemption-evidence.mjs", "case assertions"),
  entry("tools/e2e/target-architecture.mjs", "campaign"),
]);

const retiredWorkflowE2EPaths = new Set(RETIRED_WORKFLOW_E2E_INVENTORY.map(({ path }) => path));
const retiredWorkflowSymbols = [
  "createRequiredWriteOutageController",
  "RunParallelBlackBoxE2ECampaignCommand",
  "ParallelBlackBoxE2ECampaignResult",
  "human_script_id",
  "evidence_predicate_id",
  "CaseRootSet",
];
const retiredCaseIds = [
  "cross_conductor_happy_paths",
  "plan_rejection_and_supersession",
  "conductor_restart_isolation",
  "cycle_exhaustion_and_successor",
  "delivery_and_review",
  "required_linear_write_fail_closed",
];

export function inspectForegroundE2EHardCut(trackedSources) {
  const findings = [];
  for (const [path, source] of trackedSources) {
    if (retiredWorkflowE2EPaths.has(path)) {
      findings.push({ code: "retired_workflow_e2e_path", path });
    }
    for (const symbol of retiredWorkflowSymbols) {
      if (source.includes(symbol)) {
        findings.push({ code: "retired_workflow_e2e_symbol", path, symbol });
      }
    }
    if (importsProductInternal(source)) {
      findings.push({ code: "e2e_private_product_import", path });
    }
    if (readsOrWritesPodiumDatabase(source)) {
      findings.push({ code: "e2e_direct_podium_database_access", path });
    }
    if (mutatesManagedRecords(source)) {
      findings.push({ code: "e2e_managed_record_mutation", path });
    }
    if (syntheticCompletion(source)) {
      findings.push({ code: "e2e_synthetic_completion", path });
    }
    for (const caseId of retiredCaseIds) {
      if (source.includes(caseId)) {
        findings.push({ code: "retired_workflow_e2e_symbol", path, symbol: caseId });
      }
    }
  }
  return findings;
}

function entry(path, replacement) {
  return Object.freeze({ path, replacement });
}

function importsProductInternal(source) {
  return /(?:from\s*|import\s*\(?\s*)["'][^"']*(?:\/src\/internal\/|\/internal\/)[^"']*["']/u.test(source);
}

function readsOrWritesPodiumDatabase(source) {
  return /\b(?:readFile|writeFile|open|unlink|rm|stat)\s*\(\s*["'][^"']*podium\.db["']/u.test(source);
}

function mutatesManagedRecords(source) {
  return /\b(?:write|append|create|update)(?:ManagedRecord|PlanContract|StageResult|Finding|Timeline|WorkflowComment)\s*\(/u.test(source);
}

function syntheticCompletion(source) {
  return /\b(?:target_e2e_synthetic_final|synthetic[_ ]final)\b/u.test(source);
}
