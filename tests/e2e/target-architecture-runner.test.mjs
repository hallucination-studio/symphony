import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
} from "../../tools/e2e/parallel-black-box-contract.mjs";
import { runParallelBlackBoxE2ECampaign } from "../../tools/e2e/target-architecture.mjs";
import { isMissingInputConfiguration, loadE2EConfig } from "../../tools/e2e/config.mjs";

const now = "2026-07-25T00:00:00.000Z";
const deadline = "2026-07-25T00:05:00.000Z";

test("parallel black-box Campaign accepts only the closed version-one command", () => {
  const command = campaignCommand();
  assert.deepEqual(assertParallelBlackBoxE2ECampaignCommand(command), command);

  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand({ ...command, version: 2 }),
    /parallel_black_box_campaign_version_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand({
      ...command,
      conductors: command.conductors.slice(0, 2),
    }),
    /parallel_black_box_campaign_conductors_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand({
      ...command,
      cases: [{ ...command.cases[0], human_script_id: "arbitrary" }],
    }),
    /parallel_black_box_campaign_case_invalid/u,
  );
});

test("parallel black-box Campaign starts every Conductor before provisioning profiles or Cases", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(events.slice(0, 3), ["start:a", "start:b", "start:c"]);
  assert.deepEqual(events.slice(3, 6), ["profile:a", "profile:b", "profile:c"]);
  assert.deepEqual(events.slice(6, 9), ["ready:a", "ready:b", "ready:c"]);
  assert.deepEqual(events.slice(9, 11), ["root:happy-a", "root:happy-b"]);
  assert.deepEqual(result.cases.map(({ status }) => status), ["passed", "passed"]);
});

test("parallel black-box Campaign settles every Case and final-reads with a new evidence reader", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events, { rejectCaseId: "happy-a" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(result.cases.map(({ case_id, status, reason_code }) => ({
    case_id,
    status,
    reason_code,
  })), [
    { case_id: "happy-a", status: "failed", reason_code: "human_script_failed" },
    { case_id: "happy-b", status: "passed", reason_code: "evidence_satisfied" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), [
    "fresh:happy-a", "fresh:happy-b",
  ]);
});

test("parallel black-box Campaign makes an expired Case incomplete but still final-reads it", async () => {
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 20).toISOString();
  const events = [];
  const command = campaignCommand();
  command.started_at = startedAt;
  command.deadline_at = new Date(Date.now() + 1_000).toISOString();
  command.cases = [{
    ...command.cases[0],
    deadline_at: deadlineAt,
  }];
  const campaign = await runParallelBlackBoxE2ECampaign({
    command,
    ports: {
      ...ports(events),
      async runHumanScript() {
        await new Promise(() => {});
      },
    },
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code }) => ({ status, reason_code })), [
    { status: "incomplete", reason_code: "case_deadline_exceeded" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), ["fresh:happy-a"]);
});

test("parallel black-box result rejects verdict state outside passed failed or incomplete", () => {
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignResult({
      version: 1,
      campaign_id: "campaign-1",
      cases: [{
        case_id: "case-1",
        status: "running",
        reason_code: "invalid",
        evidence_refs: [],
        observed_at: now,
      }],
      durable_overlap_evidence_refs: [],
    }),
    /parallel_black_box_campaign_result_invalid/u,
  );
});

test("real E2E configuration requires a distinct external Human Actor credential", () => {
  const environment = configuredEnvironment();
  delete environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN;
  assert.throws(
    () => loadE2EConfig({ environment }),
    (error) => error.code === "e2e_configuration_invalid" &&
      error.issues.includes("linear_human_token_missing"),
  );

  environment.SYMPHONY_E2E_LINEAR_HUMAN_TOKEN = environment.SYMPHONY_E2E_LINEAR_DEV_TOKEN;
  assert.throws(
    () => loadE2EConfig({ environment }),
    (error) => error.code === "e2e_configuration_invalid" &&
      error.issues.includes("linear_actor_credentials_not_distinct"),
  );
});

test("hard-cut runner source has no internal Podium imports, direct store access, or serial scenario loop", async () => {
  const source = await readFile("tools/e2e/target-architecture.mjs", "utf8");
  assert.doesNotMatch(source, /packages\/podium\/dist\/internal|LinearSdkImpl|LinearGatewayProtocolHandlerImpl|SqlitePodiumStoreImpl/u);
  assert.doesNotMatch(source, /for\s*\([^)]*scenario|runScenarioEvidence|targetArchitectureScenarioManifest/u);
  assert.doesNotMatch(source, /waitForPlanReviewEvidence|waitForExecutionEvidence|approvePlanReviewAction/u);
});

function campaignCommand() {
  return {
    version: 1,
    campaign_id: "campaign-1",
    project_id: "project-1",
    started_at: now,
    deadline_at: deadline,
    conductors: [
      conductor("a"),
      conductor("b"),
      conductor("c"),
    ],
    cases: [
      {
        case_id: "happy-a",
        mandatory: true,
        routed_conductor_ids: ["conductor-a"],
        deadline_at: deadline,
        human_script_id: "approve_plan",
        evidence_predicate_id: "happy_path",
      },
      {
        case_id: "happy-b",
        mandatory: true,
        routed_conductor_ids: ["conductor-b"],
        deadline_at: deadline,
        human_script_id: "approve_plan",
        evidence_predicate_id: "happy_path",
      },
    ],
  };
}

function conductor(suffix) {
  return {
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `hash-${suffix}`,
    repository_identity: `repository-${suffix}`,
  };
}

function ports(events, { rejectCaseId } = {}) {
  return {
    async startConductor({ conductor }) {
      events.push(`start:${conductor.conductor_short_hash.slice(-1)}`);
    },
    async provisionProfile({ conductor }) {
      events.push(`profile:${conductor.conductor_short_hash.slice(-1)}`);
    },
    async waitForProfileReady({ conductor }) {
      events.push(`ready:${conductor.conductor_short_hash.slice(-1)}`);
    },
    async createCaseRoot({ e2eCase }) {
      events.push(`root:${e2eCase.case_id}`);
      return { root_issue_id: `root-${e2eCase.case_id}` };
    },
    async runHumanScript({ e2eCase }) {
      events.push(`human:${e2eCase.case_id}`);
      if (e2eCase.case_id === rejectCaseId) throw new Error("external failure");
    },
    async createFreshEvidenceReader({ e2eCase }) {
      events.push(`fresh:${e2eCase.case_id}`);
      return {
        async readFinalEvidence() {
          return {
            status: "passed",
            reason_code: "evidence_satisfied",
            evidence_refs: [`linear:${e2eCase.case_id}`],
          };
        },
      };
    },
    async readDurableOverlapEvidence() {
      return ["linear:overlap-1"];
    },
  };
}

function configuredEnvironment() {
  return {
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "symphony-token",
    LINEAR_CLIENT_ID: "client-id",
    SYMPHONY_E2E_PROJECT_SLUG_ID: "project-slug",
    SYMPHONY_E2E_LINEAR_SETUP_AUTHORIZED: "true",
    SYMPHONY_E2E_CODEX_API_KEY: "codex-key",
    SYMPHONY_E2E_CODEX_BASE_URL: "https://example.test",
    SYMPHONY_E2E_CODEX_MODEL: "gpt-5-codex",
  };
}

const missingConfiguration = (() => {
  try {
    loadE2EConfig({ environment: process.env });
    return undefined;
  } catch (error) {
    if (isMissingInputConfiguration(error)) return "real parallel black-box E2E configuration is not present";
    throw error;
  }
})();

test("real parallel black-box Campaign runs only with complete distinct credentials", {
  skip: missingConfiguration,
  timeout: 301_000,
}, async () => {
  await assert.rejects(
    import("../../tools/e2e/target-architecture.mjs").then(({ runConfiguredParallelBlackBoxE2ECampaign }) =>
      runConfiguredParallelBlackBoxE2ECampaign({ environment: process.env }),
    ),
    /parallel_black_box_campaign_runtime_unavailable/u,
  );
});
