import assert from "node:assert/strict";
import test from "node:test";

import {
  lastLogReason,
  latestRootFailureReason,
  readArchitectureAcceptanceManifest,
  runTargetArchitectureEvidence,
  safeErrorCode,
  targetArchitectureScenarioManifest,
  waitForExecutionEvidence,
} from "../../tools/e2e/target-architecture.mjs";
import { isMissingInputConfiguration, loadE2EConfig } from "../../tools/e2e/config.mjs";

const EVIDENCE_DEADLINE_MS = 300_000;

test("target E2E manifest is generated from the architecture acceptance section", async () => {
  const acceptance = await readArchitectureAcceptanceManifest();
  const scenarios = targetArchitectureScenarioManifest(acceptance);
  assert.equal(acceptance.length, 8);
  assert.deepEqual(scenarios.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(
    scenarios.map(({ evidence }) => evidence),
    ["linear_tree", "production_process", "production_process", "production_process",
      "production_process", "restart_recovery", "production_process", "production_process"],
  );
  for (const scenario of scenarios) assert.ok(scenario.statement.length > 0);
});

test("target E2E diagnostics prefer the concrete boundary failure over the harness wrapper", () => {
  assert.equal(lastLogReason([
    { event: "e2e_podium_handler_failed", reason: "linear_request_failed" },
    { event: "e2e_child_failed", reason: "conductor_protocol_failed" },
  ]), "linear_request_failed");
  assert.equal(lastLogReason([
    {
      event: "e2e_podium_response_error",
      request_kind: "get_workflow_issue_tree",
      code: "podium_conductor_request_failed",
    },
      { event: "linear_physical_request", operation: "SymphonyRootHeaderFacts", status: 200 },
  ]), "podium_conductor_request_failed_get_workflow_issue_tree_SymphonyRootHeaderFacts_200");
  assert.equal(lastLogReason([
    {
      event: "e2e_child_log",
      message: JSON.stringify({ event: "root_reconciliation_failed", fields: { reason: "root_directive_invalid" } }),
    },
  ]), "root_directive_invalid");
  assert.equal(lastLogReason([
    {
      event: "e2e_child_log",
      message: JSON.stringify({
        event: "root_reconciliation_failed",
        fields: {
          reason: "root_reconciliation_failed",
          failure_code: "role_result_write_linear_internal_failed",
          phase: "persist_plan_linear_write",
        },
      }),
    },
  ]), "role_result_write_linear_internal_failed");
  assert.equal(safeErrorCode(new TypeError("untrusted runtime detail")), "target_e2e_type_error");
});

test("target E2E stops when Root directive materialization fails", () => {
  assert.equal(latestRootFailureReason([
    {
      event: "e2e_child_log",
      message: JSON.stringify({
        event: "root_directive_materialization_failed",
        fields: { reason: "root_directive_create_cycle_conflict" },
      }),
    },
  ]), "root_directive_create_cycle_conflict");
});

test("target E2E execution evidence reads through the Linear gateway contract", async () => {
  let calls = 0;
  const result = await waitForExecutionEvidence({
    gateway: {
      async getWorkflowIssueTree(projectId, rootIssueId) {
        calls += 1;
        assert.equal(projectId, "project-1");
        assert.equal(rootIssueId, "root-1");
        return {
          comments: [
            { body: 'stage_result {"stage":"plan"}' },
            { body: 'stage_result {"stage":"work"}' },
            { body: 'stage_result {"stage":"work"}' },
            { body: 'stage_result {"stage":"verify"}' },
          ],
        };
      },
    },
    projectId: "project-1",
    rootIssueId: "root-1",
    deadlineAt: new Date(Date.now() + 1_000),
  });
  assert.deepEqual(result, { planResults: 1, workResults: 2, verifyResults: 1 });
  assert.equal(calls, 1);
});

test("target E2E execution evidence stops when the production boundary reports failure", async () => {
  await assert.rejects(waitForExecutionEvidence({
    gateway: {
      async getWorkflowIssueTree() {
        return { comments: [] };
      },
    },
    projectId: "project-1",
    rootIssueId: "root-1",
    deadlineAt: new Date(Date.now() + 1_000),
    failureReason: () => "provider_output_invalid_json",
  }), /target_e2e_execution_evidence_boundary_failed/u);
});

const missingConfiguration = (() => {
  try {
    loadE2EConfig({ environment: process.env });
    return undefined;
  } catch (error) {
    if (isMissingInputConfiguration(error)) return "real target E2E configuration is not present";
    throw error;
  }
})();

test("target architecture black-box evidence runs behind one absolute deadline", {
  skip: missingConfiguration,
  timeout: EVIDENCE_DEADLINE_MS + 1_000,
}, async () => {
  const result = await runTargetArchitectureEvidence({
    environment: process.env,
    deadlineAt: new Date(Date.now() + EVIDENCE_DEADLINE_MS),
  });
  assert.deepEqual(result.evidenceKinds, ["linear_tree", "production_process", "restart_recovery"]);
  assert.equal(result.acceptanceCount, 8);
  assert.equal(result.scenarioCount, 8);
});
