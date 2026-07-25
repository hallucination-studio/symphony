import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
  getParallelBlackBoxE2ECampaignExitCode,
} from "../../tools/e2e/parallel-black-box-contract.mjs";
import { createFinalCaseVerdict } from "../../tools/e2e/final-evidence-verdict.mjs";
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

test("parallel black-box Campaign final-reads after a Human script failure and lets the predicate decide", async () => {
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
    { case_id: "happy-a", status: "passed", reason_code: "evidence_satisfied" },
    { case_id: "happy-b", status: "passed", reason_code: "evidence_satisfied" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), [
    "fresh:happy-a", "fresh:happy-b",
  ]);
});

test("parallel black-box Campaign final-reads after a Human deadline and lets an inconclusive predicate decide", async () => {
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
      ...ports(events, { predicateKind: "inconclusive" }),
      async runHumanScript() {
        await new Promise(() => {});
      },
    },
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code }) => ({ status, reason_code })), [
    { status: "incomplete", reason_code: "evidence_not_converged" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), ["fresh:happy-a"]);
});

test("parallel black-box Campaign makes an incomplete fresh snapshot incomplete without invoking a predicate", async () => {
  const events = [];
  const campaign = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events, { snapshotKind: "incomplete" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code, evidence_refs }) => ({
    status,
    reason_code,
    evidence_refs,
  })), [
    { status: "incomplete", reason_code: "fresh_evidence_incomplete", evidence_refs: [] },
    { status: "incomplete", reason_code: "fresh_evidence_incomplete", evidence_refs: [] },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("predicate:")), []);
});

test("parallel black-box Campaign maps a violated final predicate to failed", async () => {
  const campaign = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports([], { predicateKind: "violated" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code }) => ({ status, reason_code })), [
    { status: "failed", reason_code: "evidence_violation" },
    { status: "failed", reason_code: "evidence_violation" },
  ]);
});

test("parallel black-box Campaign rejects a predicate that attempts to return a Case verdict", async () => {
  const campaign = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports([], { predicateKind: "passed" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code }) => ({ status, reason_code })), [
    { status: "incomplete", reason_code: "evidence_predicate_unavailable" },
    { status: "incomplete", reason_code: "evidence_predicate_unavailable" },
  ]);
});

test("final Case verdict fails closed when its predicate evaluator is unavailable", async () => {
  const e2eCase = campaignCommand().cases[0];
  const root = { root_issue_id: "root-happy-a" };
  const verdict = await createFinalCaseVerdict({
    e2eCase,
    root,
    snapshot: {
      kind: "complete",
      observed_at: now,
      root_trees: [{ root_issue_id: root.root_issue_id }],
      repositories: [{ repository_identity: "repository-a" }],
    },
    observedAt: () => now,
  });

  assert.deepEqual(verdict, {
    case_id: e2eCase.case_id,
    status: "incomplete",
    reason_code: "evidence_predicate_unavailable",
    evidence_refs: ["linear:root-happy-a", "git:repository-a"],
    observed_at: now,
  });
});

test("final Case verdict fails closed when a complete snapshot has malformed durable references", async () => {
  const e2eCase = campaignCommand().cases[0];
  const root = { root_issue_id: "root-happy-a" };
  const verdict = await createFinalCaseVerdict({
    e2eCase,
    root,
    snapshot: {
      kind: "complete",
      observed_at: now,
      root_trees: [{ root_issue_id: root.root_issue_id }],
      repositories: [{ repository_identity: null }],
    },
    evaluateEvidencePredicate: async () => ({
      kind: "satisfied",
      reason_code: "evidence_satisfied",
    }),
    observedAt: () => now,
  });

  assert.deepEqual(verdict, {
    case_id: e2eCase.case_id,
    status: "incomplete",
    reason_code: "fresh_evidence_invalid",
    evidence_refs: [],
    observed_at: now,
  });
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

test("parallel black-box Campaign exit code fails when a mandatory final verdict is non-passing", async () => {
  const command = campaignCommand();
  const result = await runParallelBlackBoxE2ECampaign({
    command,
    ports: ports([], { predicateKind: "violated" }),
    now: () => Date.parse(now),
  });

  assert.equal(getParallelBlackBoxE2ECampaignExitCode(command, result), 1);
  assert.equal(getParallelBlackBoxE2ECampaignExitCode({
    ...command,
    cases: command.cases.map((e2eCase) => ({ ...e2eCase, mandatory: false })),
  }, result), 0);
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
  assert.doesNotMatch(source, /createFreshEvidenceReader|\.readFinalEvidence\(|caseResult\(|readDurableOverlapEvidence/u);
  assert.match(source, /createFinalCaseVerdict\(/u);
  assert.doesNotMatch(source, /status:\s*["'](?:passed|failed|incomplete)["']/u);
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

function ports(events, { rejectCaseId, snapshotKind = "complete", predicateKind = "satisfied" } = {}) {
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
    async readFreshEvidenceSnapshot({ e2eCase, root }) {
      events.push(`fresh:${e2eCase.case_id}`);
      if (snapshotKind === "incomplete") {
        return {
          kind: "incomplete",
          observed_at: now,
          omissions: [{ source_id: root.root_issue_id, reason_code: "fresh_linear_coverage_incomplete" }],
        };
      }
      return {
        kind: "complete",
        observed_at: now,
        root_trees: [{ root_issue_id: root.root_issue_id }],
        repositories: [{ repository_identity: `repository-${e2eCase.routed_conductor_ids[0].slice(-1)}` }],
      };
    },
    async evaluateEvidencePredicate({ e2e_case: e2eCase, snapshot }) {
      events.push(`predicate:${e2eCase.case_id}`);
      assert.equal(snapshot.kind, "complete");
      return {
        kind: predicateKind,
        reason_code: {
          satisfied: "evidence_satisfied",
          violated: "evidence_violation",
          inconclusive: "evidence_not_converged",
        }[predicateKind],
      };
    },
  };
}

function configuredEnvironment() {
  return {
    SYMPHONY_E2E_LINEAR_DEV_TOKEN: "symphony-token",
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
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
