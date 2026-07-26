import assert from "node:assert/strict";
import test from "node:test";

import { createMandatoryParallelBlackBoxCases } from "../../tools/e2e/parallel-black-box-contract.mjs";
import {
  runParallelBlackBoxCampaignCommand,
  sanitizeParallelBlackBoxCampaignFailure,
} from "../../tools/e2e/parallel-black-box-cli.mjs";

test("real Campaign CLI emits only the closed result and succeeds when every mandatory Case passed", async () => {
  const command = campaignCommand();
  const result = campaignResult(command);
  const output = [];

  const exitCode = await runParallelBlackBoxCampaignCommand({
    runConfiguredCampaign: async () => ({ command, result }),
    writeOutput: (value) => output.push(value),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(output, [`${JSON.stringify(result)}\n`]);
});

test("real Campaign CLI emits durable non-passing evidence and exits nonzero", async () => {
  const command = campaignCommand();
  const result = campaignResult(command, { case_id: "delivery_and_review", status: "incomplete" });
  const output = [];

  const exitCode = await runParallelBlackBoxCampaignCommand({
    runConfiguredCampaign: async () => ({ command, result }),
    writeOutput: (value) => output.push(value),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(output, [`${JSON.stringify(result)}\n`]);
});

test("real Campaign CLI exposes only allowlisted stable startup failure codes", () => {
  assert.deepEqual(
    sanitizeParallelBlackBoxCampaignFailure({ code: "parallel_black_box_runtime_control_plane_failed" }),
    {
      status: "failed",
      reason_code: "parallel_black_box_runtime_control_plane_failed",
      issues: [],
    },
  );
  assert.deepEqual(
    sanitizeParallelBlackBoxCampaignFailure({
      code: "parallel_black_box_control_plane_binding_project_pool_routing_conflict",
    }),
    {
      status: "failed",
      reason_code: "parallel_black_box_control_plane_binding_project_pool_routing_conflict",
      issues: [],
    },
  );
  assert.deepEqual(
    sanitizeParallelBlackBoxCampaignFailure({
      code: "external_linear_e2e_project_reset_label_ownership_invalid",
    }),
    {
      status: "failed",
      reason_code: "external_linear_e2e_project_reset_label_ownership_invalid",
      issues: [],
    },
  );
  assert.deepEqual(
    sanitizeParallelBlackBoxCampaignFailure({
      code: "remote_error_with_human-api-key",
      issues: ["human-api-key"],
    }),
    {
      status: "failed",
      reason_code: "parallel_black_box_campaign_failed",
      issues: [],
    },
  );
});

function campaignCommand() {
  const conductors = ["a", "b", "c"].map((suffix) => ({
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `abcdef12345${suffix === "a" ? "6" : suffix === "b" ? "7" : "8"}`,
    repository_identity: `repository-${suffix}`,
  }));
  return {
    version: 1,
    campaign_id: "campaign-1",
    project_id: "project-1",
    started_at: "2026-07-26T00:00:00.000Z",
    deadline_at: "2026-07-26T00:05:00.000Z",
    conductors,
    cases: createMandatoryParallelBlackBoxCases({
      conductor_ids: conductors.map(({ conductor_id: conductorId }) => conductorId),
      deadline_at: "2026-07-26T00:05:00.000Z",
    }),
  };
}

function campaignResult(command, replacement = {}) {
  return {
    version: 1,
    campaign_id: command.campaign_id,
    cases: command.cases.map(({ case_id: caseId }) => ({
      case_id: caseId,
      status: replacement.case_id === caseId ? replacement.status : "passed",
      reason_code: replacement.case_id === caseId ? "fresh_evidence_incomplete" : "confirmed",
      evidence_refs: [`linear:${caseId}`],
      observed_at: "2026-07-26T00:05:00.000Z",
    })),
    durable_overlap_evidence_refs: ["linear:root-1", "git:repository-a"],
  };
}
