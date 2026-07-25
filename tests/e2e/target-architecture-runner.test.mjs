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
import { happyPathRow } from "./approved-happy-path-fixture.mjs";
import { sameConductorPreemptionRow } from "./same-conductor-preemption-fixture.mjs";

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
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand({
      ...command,
      cases: [{ ...command.cases[0], deadline_at: "2026-07-25T00:05:01.000Z" }],
    }),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand({
      ...command,
      cases: [{ ...command.cases[0], deadline_at: command.started_at }],
    }),
    /parallel_black_box_campaign_case_invalid/u,
  );
});

test("parallel black-box Campaign begins Case work from an already-ready Conductor pool", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(events.slice(0, 2), ["root:happy-a", "root:happy-b"]);
  assert.deepEqual(result.cases.map(({ status }) => status), ["passed", "passed"]);
  assert.deepEqual(events.filter((event) => event.startsWith("human:")), ["human:happy-a", "human:happy-b"]);
  assert.deepEqual(result.durable_overlap_evidence_refs, [
    "linear:root-happy-a:stage_execution:plan-execution-happy-a",
    "linear:root-happy-a:stage_result:plan-result-happy-a",
    "linear:root-happy-b:stage_execution:plan-execution-happy-b",
    "linear:root-happy-b:stage_result:plan-result-happy-b",
  ]);
});

test("parallel black-box Campaign final-reads after an approved Plan action failure and lets durable facts decide", async () => {
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
    { case_id: "happy-a", status: "passed", reason_code: "happy_path_overlap_confirmed" },
    { case_id: "happy-b", status: "passed", reason_code: "happy_path_overlap_confirmed" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), [
    "fresh:happy-a", "fresh:happy-b",
  ]);
});

test("parallel black-box Campaign settles every Case when another Case Root cannot be created", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events, { rejectRootCaseId: "happy-a" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(result.cases.map(({ case_id, status, reason_code }) => ({
    case_id,
    status,
    reason_code,
  })), [
    { case_id: "happy-a", status: "incomplete", reason_code: "fresh_evidence_incomplete" },
    { case_id: "happy-b", status: "incomplete", reason_code: "happy_path_overlap_missing" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), ["fresh:happy-b"]);
  assert.deepEqual(events.filter((event) => event.startsWith("predicate:")), []);
});

test("parallel black-box Campaign treats a malformed Case Root as isolated incomplete evidence", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: {
      ...ports(events),
      async createCaseRoots({ e2eCase }) {
        events.push(`root:${e2eCase.case_id}`);
        if (e2eCase.case_id === "happy-a") return { root_issue_ids: ["not a Linear issue id"] };
        return { root_issue_ids: [`root-${e2eCase.case_id}`] };
      },
    },
    now: () => Date.parse(now),
  });

  assert.deepEqual(result.cases.map(({ case_id, status, reason_code }) => ({
    case_id,
    status,
    reason_code,
  })), [
    { case_id: "happy-a", status: "incomplete", reason_code: "fresh_evidence_incomplete" },
    { case_id: "happy-b", status: "incomplete", reason_code: "happy_path_overlap_missing" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), ["fresh:happy-b"]);
});

test("parallel black-box Campaign gives each Case only its routed Conductor context", async () => {
  const contexts = [];
  await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: {
      ...ports([]),
      async createCaseRoots({ caseContext, e2eCase }) {
        contexts.push({
          case_id: e2eCase.case_id,
          campaign_id: caseContext?.campaign_id,
          project_id: caseContext?.project_id,
          human_actor_id: caseContext?.human_actor_id,
          conductor_ids: caseContext?.conductors.map(({ conductor_id }) => conductor_id),
          frozen: Object.isFrozen(caseContext)
            && Object.isFrozen(caseContext?.conductors)
            && caseContext?.conductors.every((conductor) => Object.isFrozen(conductor)),
        });
        return { root_issue_ids: [`root-${e2eCase.case_id}`] };
      },
    },
    now: () => Date.parse(now),
  });

  assert.deepEqual(contexts, [
    {
      case_id: "happy-a",
      campaign_id: "campaign-1",
      project_id: "project-1",
      human_actor_id: "human-actor",
      conductor_ids: ["conductor-a"],
      frozen: true,
    },
    {
      case_id: "happy-b",
      campaign_id: "campaign-1",
      project_id: "project-1",
      human_actor_id: "human-actor",
      conductor_ids: ["conductor-b"],
      frozen: true,
    },
  ]);
});

test("parallel black-box Campaign verifies the external Human identity before creating any Case Root", async () => {
  const events = [];
  const base = ports(events);
  await assert.rejects(
    runParallelBlackBoxE2ECampaign({
      command: campaignCommand(),
      ports: {
        ...base,
        human: {
          ...base.human,
          async readActorId() { throw new Error("external identity unavailable"); },
        },
      },
      now: () => Date.parse(now),
    }),
    (error) => error.code === "parallel_black_box_human_actor_identity_invalid",
  );
  assert.deepEqual(events.filter((event) => event.startsWith("root:")), []);
});

test("parallel black-box Campaign exposes only a frozen CaseRootSet to final evidence", async () => {
  const observedRoots = [];
  const command = campaignCommand();
  command.cases = [command.cases[0]];
  await runParallelBlackBoxE2ECampaign({
    command,
    ports: {
      ...ports([]),
      async createCaseRoots() {
        return { root_issue_ids: ["root-happy-a"] };
      },
      async readFreshEvidenceSnapshot({ caseRoots }) {
        observedRoots.push({ port: "evidence", caseRoots, frozen: Object.isFrozen(caseRoots) });
        return {
          kind: "complete",
          observed_at: now,
          root_trees: [{ root_issue_id: caseRoots.root_issue_ids[0] }],
          repositories: [{ repository_identity: "repository-a" }],
        };
      },
    },
    now: () => Date.parse(now),
  });

  assert.deepEqual(observedRoots, [
    { port: "evidence", caseRoots: { root_issue_ids: ["root-happy-a"] }, frozen: true },
  ]);
});

test("parallel black-box Campaign derives same-Conductor preemption from its two fresh Root Trees", async () => {
  const command = campaignCommand();
  command.cases = [{
    case_id: "same-priority",
    mandatory: true,
    routed_conductor_ids: ["conductor-a"],
    deadline_at: deadline,
    human_script_id: "preempt_same_priority",
    evidence_predicate_id: "same_conductor_preemption",
  }];
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command,
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(result.cases.map(({ status, reason_code }) => ({ status, reason_code })), [{
    status: "passed",
    reason_code: "same_conductor_preemption_confirmed",
  }]);
  assert.deepEqual(result.durable_overlap_evidence_refs, []);
  assert.deepEqual(events.filter((event) => event.startsWith("human-update:")), ["human-update:root-updated"]);
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
      ...ports(events, { snapshotKind: "incomplete" }),
      async waitForHumanAction() {
        return new Promise(() => {});
      },
    },
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code }) => ({ status, reason_code })), [
    { status: "incomplete", reason_code: "fresh_evidence_incomplete" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), ["fresh:happy-a"]);
});

test("parallel black-box Campaign waits for every Human action before final fresh reads", async () => {
  const startedAt = new Date().toISOString();
  const aDeadline = new Date(Date.now() + 20).toISOString();
  const bDeadline = new Date(Date.now() + 200).toISOString();
  const campaignDeadline = new Date(Date.now() + 500).toISOString();
  const events = [];
  const command = campaignCommand();
  command.started_at = startedAt;
  command.deadline_at = campaignDeadline;
  command.cases = [
    { ...command.cases[0], deadline_at: aDeadline },
    { ...command.cases[1], deadline_at: bDeadline },
  ];
  const campaign = await runParallelBlackBoxE2ECampaign({
    command,
    ports: {
      ...ports(events),
      async waitForHumanAction({ e2eCase }) {
        events.push(`human:${e2eCase.case_id}`);
        if (e2eCase.case_id === "happy-a") await new Promise(() => {});
        return { human_action_issue_id: `action-${e2eCase.case_id}` };
      },
    },
  });

  assert.deepEqual(campaign.cases.map(({ case_id, status, reason_code }) => ({
    case_id,
    status,
    reason_code,
  })), [
    { case_id: "happy-a", status: "passed", reason_code: "happy_path_overlap_confirmed" },
    { case_id: "happy-b", status: "passed", reason_code: "happy_path_overlap_confirmed" },
  ]);
  assert.deepEqual(events.filter((event) => event.startsWith("fresh:")), ["fresh:happy-a", "fresh:happy-b"]);
  assert.equal(events.indexOf("human:happy-b") < events.indexOf("fresh:happy-a"), true);
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

test("parallel black-box Campaign maps a durable non-overlap to failed", async () => {
  const campaign = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports([], { startOffsetsByCaseId: { "happy-b": 10_000 } }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code }) => ({ status, reason_code })), [
    { status: "failed", reason_code: "happy_path_overlap_absent" },
    { status: "failed", reason_code: "happy_path_overlap_absent" },
  ]);
});

test("final Case verdict fails closed when its predicate evaluator is unavailable", async () => {
  const e2eCase = campaignCommand().cases[0];
  const caseRoots = { root_issue_ids: ["root-happy-a"] };
  const verdict = await createFinalCaseVerdict({
    e2eCase,
    caseRoots,
    snapshot: {
      kind: "complete",
      observed_at: now,
      root_trees: [{ root_issue_id: caseRoots.root_issue_ids[0] }],
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
  const caseRoots = { root_issue_ids: ["root-happy-a"] };
  const verdict = await createFinalCaseVerdict({
    e2eCase,
    caseRoots,
    snapshot: {
      kind: "complete",
      observed_at: now,
      root_trees: [{ root_issue_id: caseRoots.root_issue_ids[0] }],
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

test("final Case verdict fails closed when fresh evidence omits a CaseRootSet member", async () => {
  const e2eCase = campaignCommand().cases[0];
  const verdict = await createFinalCaseVerdict({
    e2eCase,
    caseRoots: { root_issue_ids: ["root-happy-a", "root-related"] },
    snapshot: {
      kind: "complete",
      observed_at: now,
      root_trees: [{ root_issue_id: "root-happy-a" }],
      repositories: [{ repository_identity: "repository-a" }],
    },
    observedAt: () => now,
  });

  assert.deepEqual(verdict, {
    case_id: e2eCase.case_id,
    status: "incomplete",
    reason_code: "fresh_evidence_root_missing",
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
    ports: ports([], { startOffsetsByCaseId: { "happy-b": 10_000 } }),
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
  assert.doesNotMatch(source, /runHumanScript|ports\.evaluateEvidencePredicate/u);
  assert.doesNotMatch(source, /\bcreateCaseRoot\b/u);
  assert.doesNotMatch(source, /createFreshEvidenceReader|\.readFinalEvidence\(|caseResult\(|readDurableOverlapEvidence/u);
  assert.doesNotMatch(source, /\b(?:startConductor|provisionProfile|waitForProfileReady)\b/u);
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

function ports(events, {
  rejectCaseId,
  rejectRootCaseId,
  snapshotKind = "complete",
  startOffsetsByCaseId = {},
} = {}) {
  return {
    async createCaseRoots({ e2eCase }) {
      events.push(`root:${e2eCase.case_id}`);
      if (e2eCase.case_id === rejectRootCaseId) throw new Error("external root failure");
      if (e2eCase.human_script_id === "preempt_same_priority") {
        return { root_issue_ids: ["root-inflight", "root-updated"] };
      }
      return { root_issue_ids: [`root-${e2eCase.case_id}`] };
    },
    human: {
      async readActorId() { return "human-actor"; },
      async resolveHumanAction({ human_action_issue_id: actionIssueId }) {
        const caseId = actionIssueId.slice("action-".length);
        if (caseId === rejectCaseId) throw new Error("external failure");
      },
      async updateRoot({ root_issue_id: rootIssueId }) {
        events.push(`human-update:${rootIssueId}`);
      },
    },
    async waitForHumanAction({ e2eCase, root_issue_id: rootIssueId, action_kind: actionKind }) {
      events.push(`human:${e2eCase.case_id}`);
      assert.equal(rootIssueId, `root-${e2eCase.case_id}`);
      assert.equal(actionKind, "plan_review");
      return { human_action_issue_id: `action-${e2eCase.case_id}` };
    },
    async waitForInFlightStage({ e2eCase, root_issue_id: rootIssueId }) {
      assert.equal(e2eCase.human_script_id, "preempt_same_priority");
      assert.equal(rootIssueId, "root-inflight");
      return { stage_execution_id: "execution-inflight" };
    },
    async readFreshEvidenceSnapshot({ e2eCase, caseRoots }) {
      events.push(`fresh:${e2eCase.case_id}`);
      if (snapshotKind === "incomplete") {
        return {
          kind: "incomplete",
          observed_at: now,
          omissions: [{ source_id: caseRoots.root_issue_ids[0], reason_code: "fresh_linear_coverage_incomplete" }],
        };
      }
      if (e2eCase.evidence_predicate_id === "same_conductor_preemption") {
        const fixture = sameConductorPreemptionRow();
        assert.deepEqual(caseRoots, fixture.caseRoots);
        return fixture.snapshot;
      }
      const conductorId = e2eCase.routed_conductor_ids[0];
      const suffix = conductorId.slice("conductor-".length);
      const fixture = happyPathRow({
        caseId: e2eCase.case_id,
        conductorId,
        repositoryIdentity: `repository-${suffix}`,
        startOffset: startOffsetsByCaseId[e2eCase.case_id] ?? 0,
      });
      assert.deepEqual(caseRoots, fixture.caseRoots);
      return fixture.snapshot;
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
