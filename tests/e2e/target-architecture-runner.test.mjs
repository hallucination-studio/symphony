import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertParallelBlackBoxE2ECampaignCommand,
  assertParallelBlackBoxE2ECampaignResult,
  createMandatoryParallelBlackBoxCases,
  getParallelBlackBoxE2ECampaignExitCode,
  MANDATORY_PARALLEL_BLACK_BOX_CASE_REGISTRY,
} from "../../tools/e2e/parallel-black-box-contract.mjs";
import { createFinalCaseVerdict } from "../../tools/e2e/final-evidence-verdict.mjs";
import { runParallelBlackBoxE2ECampaign } from "../../tools/e2e/target-architecture.mjs";
import { isMissingInputConfiguration, loadE2EConfig } from "../../tools/e2e/config.mjs";
import { happyPathRow } from "./approved-happy-path-fixture.mjs";
import { cycleSuccessorRow } from "./cycle-successor-fixture.mjs";
import { planRejectionSupersessionRow } from "./plan-rejection-supersession-fixture.mjs";
import { requiredWriteOutageRow } from "./required-write-outage-fixture.mjs";
import { rootRevisionCommentRow } from "./root-revision-comment-fixture.mjs";
import { restartIsolationRow } from "./restart-isolation-fixture.mjs";
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
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "cross_conductor_happy_paths", {
      human_script_id: "arbitrary",
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "cross_conductor_happy_paths", {
      deadline_at: "2026-07-25T00:05:01.000Z",
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "cross_conductor_happy_paths", {
      deadline_at: command.started_at,
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "conductor_restart_isolation", {
      evidence_predicate_id: "happy_path",
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "conductor_restart_isolation", {
      routed_conductor_ids: ["conductor-c", "conductor-a"],
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "cross_conductor_happy_paths", {
      human_script_id: "exhaust_cycle_budget",
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "cross_conductor_happy_paths", {
      evidence_predicate_id: "cycle_successor",
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "delivery_and_review", {
      human_script_id: "approve_plan",
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(command, "required_linear_write_fail_closed", {
      evidence_predicate_id: "happy_path",
    })),
    /parallel_black_box_campaign_case_invalid/u,
  );
});

test("parallel black-box Campaign rejects a partial or aliased mandatory Case registry", () => {
  const command = campaignCommand();

  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand({ ...command, cases: command.cases.slice(0, -1) }),
    /parallel_black_box_campaign_registry_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand({
      ...command,
      cases: command.cases.map((e2eCase) => e2eCase.case_id === "cross_conductor_happy_paths"
        ? { ...e2eCase, case_id: "cross_conductor_happy_paths_alias" }
        : e2eCase),
    }),
    /parallel_black_box_campaign_registry_invalid/u,
  );
});

test("parallel black-box Campaign exposes exactly the documented mandatory Case registry", () => {
  assert.deepEqual(MANDATORY_PARALLEL_BLACK_BOX_CASE_REGISTRY.map((definition) => ({
    case_id: definition.case_id,
    human_script_id: definition.human_script_id,
    evidence_predicate_id: definition.evidence_predicate_id,
    routed_conductor_indexes: definition.routed_conductor_indexes,
  })), [
    { case_id: "cross_conductor_happy_paths", human_script_id: "approve_plan", evidence_predicate_id: "happy_path", routed_conductor_indexes: [0, 1] },
    { case_id: "same_conductor_preemption", human_script_id: "preempt_same_priority", evidence_predicate_id: "same_conductor_preemption", routed_conductor_indexes: [0] },
    { case_id: "plan_rejection_and_supersession", human_script_id: "reject_plan", evidence_predicate_id: "plan_rejection_supersession", routed_conductor_indexes: [0] },
    { case_id: "root_revision_and_comment", human_script_id: "revise_root", evidence_predicate_id: "root_revision_comment", routed_conductor_indexes: [0] },
    { case_id: "conductor_restart_isolation", human_script_id: "restart_conductor", evidence_predicate_id: "restart_isolation", routed_conductor_indexes: [2, 0, 1] },
    { case_id: "cycle_exhaustion_and_successor", human_script_id: "exhaust_cycle_budget", evidence_predicate_id: "cycle_successor", routed_conductor_indexes: [0] },
    { case_id: "delivery_and_review", human_script_id: "deliver_and_review", evidence_predicate_id: "delivery_review", routed_conductor_indexes: [0] },
    { case_id: "required_linear_write_fail_closed", human_script_id: "required_write_outage", evidence_predicate_id: "required_write_fail_closed", routed_conductor_indexes: [0] },
  ]);

  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(campaignCommand(), "delivery_and_review", { mandatory: false })),
    /parallel_black_box_campaign_registry_invalid/u,
  );
  assert.throws(
    () => assertParallelBlackBoxE2ECampaignCommand(changeCase(campaignCommand(), "cross_conductor_happy_paths", {
      routed_conductor_ids: ["conductor-b", "conductor-a"],
    })),
    /parallel_black_box_campaign_registry_invalid/u,
  );
});

test("parallel black-box Campaign begins Case work from an already-ready Conductor pool", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(events.slice(0, 8), [
    "root:cross_conductor_happy_paths",
    "root:same_conductor_preemption",
    "root:plan_rejection_and_supersession",
    "root:root_revision_and_comment",
    "root:conductor_restart_isolation",
    "root:cycle_exhaustion_and_successor",
    "root:delivery_and_review",
    "root:required_linear_write_fail_closed",
  ]);
  assert.deepEqual(result.cases.map(({ status }) => status), Array(8).fill("passed"));
  assert.equal(events.filter((event) => event === "human:cross_conductor_happy_paths").length, 2);
  assert.deepEqual(result.durable_overlap_evidence_refs, [
    "linear:root-happy-a:stage_execution:plan-execution-happy-a",
    "linear:root-happy-a:stage_result:plan-result-happy-a",
    "linear:root-happy-b:stage_execution:plan-execution-happy-b",
    "linear:root-happy-b:stage_result:plan-result-happy-b",
  ]);
});

test("parallel black-box Campaign accepts delivery and review only from the final fresh Linear and Git chain", async () => {
  const events = [];

  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "delivery_and_review"), {
    case_id: "delivery_and_review",
    status: "passed",
    reason_code: "delivery_review_confirmed",
    evidence_refs: ["linear:root-delivery_and_review", "git:repository-a"],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event === "human:delivery_and_review"), ["human:delivery_and_review"]);
  assert.deepEqual(events.filter((event) => event === "fresh:delivery_and_review"), ["fresh:delivery_and_review"]);
});

test("parallel black-box Campaign rejects a Root revision Case without its public reply-wait boundary", async () => {
  const command = campaignCommand();
  const events = [];
  const campaignPorts = ports(events);
  delete campaignPorts.waitForRootReconcilerReply;

  await assert.rejects(
    runParallelBlackBoxE2ECampaign({ command, ports: campaignPorts, now: () => Date.parse(now) }),
    (error) => error.code === "parallel_black_box_campaign_ports_invalid",
  );
  assert.deepEqual(events, []);
});

test("parallel black-box Campaign derives the Root revision verdict only from final fresh Linear evidence", async () => {
  const command = campaignCommand();
  const events = [];

  const result = await runParallelBlackBoxE2ECampaign({
    command,
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "root_revision_and_comment"), {
    case_id: "root_revision_and_comment",
    status: "passed",
    reason_code: "root_revision_comment_confirmed",
    evidence_refs: ["linear:root-revision", "git:repository-a"],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event.startsWith("human-revision:")), [
    "human-revision:update:root-revision",
    "human-revision:create:root-revision",
    "human-revision:edit:comment-revision",
    "human-revision:resolve:comment-revision",
    "human-revision:wait:resolved:comment-revision",
    "human-revision:reopen:comment-revision",
    "human-revision:wait:unresolved:comment-revision",
  ]);
  assert.deepEqual(events.filter((event) => event === "fresh:root_revision_and_comment"), ["fresh:root_revision_and_comment"]);
});

test("parallel black-box Campaign requires the external restart port for the mandatory registry", async () => {
  const command = campaignCommand();
  const events = [];
  const campaignPorts = ports(events);
  delete campaignPorts.restartConductor;

  await assert.rejects(
    runParallelBlackBoxE2ECampaign({ command, ports: campaignPorts, now: () => Date.parse(now) }),
    (error) => error.code === "parallel_black_box_campaign_ports_invalid",
  );
  assert.deepEqual(events, []);
});

test("parallel black-box Campaign invokes only the external C restart boundary and final-reads restart isolation", async () => {
  const events = [];

  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "conductor_restart_isolation"), {
    case_id: "conductor_restart_isolation",
    status: "passed",
    reason_code: "restart_isolation_confirmed",
    evidence_refs: ["linear:root-restart-c", "linear:root-restart-a", "linear:root-restart-b", "git:repository-c", "git:repository-a", "git:repository-b"],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event.startsWith("restart:")), ["restart:conductor-c:root-restart-c"]);
  assert.deepEqual(events.filter((event) => event === "fresh:conductor_restart_isolation"), ["fresh:conductor_restart_isolation"]);
});

test("parallel black-box Campaign requires bounded outage control ports for the mandatory registry", async () => {
  const command = campaignCommand();
  const events = [];
  const campaignPorts = ports(events);
  delete campaignPorts.waitForRequiredWriteOutage;

  await assert.rejects(
    runParallelBlackBoxE2ECampaign({ command, ports: campaignPorts, now: () => Date.parse(now) }),
    (error) => error.code === "parallel_black_box_campaign_ports_invalid",
  );
  assert.deepEqual(events, []);
});

test("parallel black-box Campaign restores the bounded required write before approving Plan and final-reading durable evidence", async () => {
  const events = [];

  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "required_linear_write_fail_closed"), {
    case_id: "required_linear_write_fail_closed",
    status: "passed",
    reason_code: "required_write_fail_closed_confirmed",
    evidence_refs: ["linear:root-required-write", "git:repository-a"],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event.startsWith("required-write:") ||
    event === "human:required_linear_write_fail_closed" || event === "fresh:required_linear_write_fail_closed"), [
    "required-write:wait:root-required-write",
    "required-write:restore:root-required-write",
    "human:required_linear_write_fail_closed",
    "fresh:required_linear_write_fail_closed",
  ]);
});

test("parallel black-box Campaign marks required-write outage incomplete when its gate rendezvous does not complete", async () => {
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 20).toISOString();
  const command = campaignCommand();
  command.started_at = startedAt;
  command.deadline_at = new Date(Date.now() + 1_000).toISOString();
  command.cases = command.cases.map((e2eCase) => ({
    ...e2eCase,
    deadline_at: e2eCase.case_id === "required_linear_write_fail_closed" ? deadlineAt : command.deadline_at,
  }));
  const events = [];

  const result = await runParallelBlackBoxE2ECampaign({
    command,
    ports: {
      ...ports(events),
      async waitForRequiredWriteOutage() {
        return new Promise(() => {});
      },
    },
  });

  assert.deepEqual(caseResult(result, "required_linear_write_fail_closed"), {
    case_id: "required_linear_write_fail_closed",
    status: "incomplete",
    reason_code: "fresh_evidence_incomplete",
    evidence_refs: [],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event === "fresh:required_linear_write_fail_closed"), []);
});

test("parallel black-box Campaign final-reads after an approved Plan action failure and lets durable facts decide", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events, { rejectCaseId: "cross_conductor_happy_paths" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "cross_conductor_happy_paths"), {
    case_id: "cross_conductor_happy_paths",
    status: "passed",
    reason_code: "happy_path_overlap_confirmed",
    evidence_refs: [
      "linear:root-happy-a", "linear:root-happy-b", "git:repository-a", "git:repository-b",
    ],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event === "fresh:cross_conductor_happy_paths"), ["fresh:cross_conductor_happy_paths"]);
});

test("parallel black-box Campaign settles every Case when another Case Root cannot be created", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events, { rejectRootCaseId: "cross_conductor_happy_paths" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "cross_conductor_happy_paths"), {
    case_id: "cross_conductor_happy_paths",
    status: "incomplete",
    reason_code: "fresh_evidence_incomplete",
    evidence_refs: [],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event === "fresh:cross_conductor_happy_paths"), []);
  assert.deepEqual(events.filter((event) => event.startsWith("predicate:")), []);
});

test("parallel black-box Campaign treats a malformed Case Root as isolated incomplete evidence", async () => {
  const events = [];
  const base = ports(events);
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: {
      ...base,
      async createCaseRoots(input) {
        if (input.e2eCase.case_id === "cross_conductor_happy_paths") {
          events.push(`root:${input.e2eCase.case_id}`);
          return { root_issue_ids: ["not a Linear issue id"] };
        }
        return base.createCaseRoots(input);
      },
    },
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "cross_conductor_happy_paths"), {
    case_id: "cross_conductor_happy_paths",
    status: "incomplete",
    reason_code: "fresh_evidence_incomplete",
    evidence_refs: [],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event === "fresh:cross_conductor_happy_paths"), []);
});

test("parallel black-box Campaign gives each Case only its routed Conductor context", async () => {
  const contexts = [];
  const base = ports([]);
  await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: {
      ...base,
      async createCaseRoots(input) {
        const { caseContext, e2eCase } = input;
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
        return base.createCaseRoots(input);
      },
    },
    now: () => Date.parse(now),
  });

  assert.deepEqual(contexts.map(({ case_id, conductor_ids }) => ({ case_id, conductor_ids })), [
    { case_id: "cross_conductor_happy_paths", conductor_ids: ["conductor-a", "conductor-b"] },
    { case_id: "same_conductor_preemption", conductor_ids: ["conductor-a"] },
    { case_id: "plan_rejection_and_supersession", conductor_ids: ["conductor-a"] },
    { case_id: "root_revision_and_comment", conductor_ids: ["conductor-a"] },
    { case_id: "conductor_restart_isolation", conductor_ids: ["conductor-c", "conductor-a", "conductor-b"] },
    { case_id: "cycle_exhaustion_and_successor", conductor_ids: ["conductor-a"] },
    { case_id: "delivery_and_review", conductor_ids: ["conductor-a"] },
    { case_id: "required_linear_write_fail_closed", conductor_ids: ["conductor-a"] },
  ]);
  assert.equal(contexts.every(({ campaign_id, project_id, human_actor_id, frozen }) =>
    campaign_id === "campaign-1" && project_id === "project-1" && human_actor_id === "human-actor" && frozen), true);
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
  const base = ports([]);
  await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: {
      ...base,
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

  assert.equal(observedRoots.length, 8);
  assert.equal(observedRoots.every(({ frozen }) => frozen), true);
  assert.deepEqual(observedRoots[0], {
    port: "evidence",
    caseRoots: { root_issue_ids: ["root-happy-a", "root-happy-b"] },
    frozen: true,
  });
});

test("parallel black-box Campaign derives same-Conductor preemption from its two fresh Root Trees", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "same_conductor_preemption"), {
    case_id: "same_conductor_preemption",
    status: "passed",
    reason_code: "same_conductor_preemption_confirmed",
    evidence_refs: ["linear:root-inflight", "linear:root-updated", "git:repository-a"],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event === "human-update:root-updated"), ["human-update:root-updated"]);
});

test("parallel black-box Campaign derives Plan rejection supersession only from its final fresh Root Tree", async () => {
  const events = [];
  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "plan_rejection_and_supersession"), {
    case_id: "plan_rejection_and_supersession",
    status: "passed",
    reason_code: "plan_rejection_supersession_confirmed",
    evidence_refs: ["linear:root-plan-rejection", "git:repository-a"],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event.startsWith("human-reject:")), ["human-reject:action-plan_rejection_and_supersession"]);
});

test("parallel black-box Campaign approves the initial Plan and derives Cycle exhaustion only from final fresh evidence", async () => {
  const events = [];

  const result = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(result, "cycle_exhaustion_and_successor"), {
    case_id: "cycle_exhaustion_and_successor",
    status: "passed",
    reason_code: "cycle_successor_confirmed",
    evidence_refs: ["linear:root-cycle-exhaustion", "git:repository-a"],
    observed_at: now,
  });
  assert.deepEqual(events.filter((event) => event === "human:cycle_exhaustion_and_successor"), ["human:cycle_exhaustion_and_successor"]);
  assert.deepEqual(events.filter((event) => event === "fresh:cycle_exhaustion_and_successor"), ["fresh:cycle_exhaustion_and_successor"]);
});

test("parallel black-box Campaign final-reads after a Human deadline and lets an inconclusive predicate decide", async () => {
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 20).toISOString();
  const events = [];
  const command = campaignCommand();
  command.started_at = startedAt;
  command.deadline_at = new Date(Date.now() + 1_000).toISOString();
  command.cases = command.cases.map((e2eCase) => ({
    ...e2eCase,
    deadline_at: e2eCase.case_id === "cross_conductor_happy_paths" ? deadlineAt : command.deadline_at,
  }));
  const campaign = await runParallelBlackBoxE2ECampaign({
    command,
    ports: {
      ...ports(events, { snapshotKind: "incomplete" }),
      async waitForHumanAction({ e2eCase, root_issue_id: rootIssueId }) {
        if (e2eCase.case_id === "cross_conductor_happy_paths") return new Promise(() => {});
        return { human_action_issue_id: `action-${rootIssueId}` };
      },
    },
  });

  const timedOutCase = caseResult(campaign, "cross_conductor_happy_paths");
  assert.deepEqual({
    case_id: timedOutCase.case_id,
    status: timedOutCase.status,
    reason_code: timedOutCase.reason_code,
    evidence_refs: timedOutCase.evidence_refs,
  }, {
    case_id: "cross_conductor_happy_paths",
    status: "incomplete",
    reason_code: "fresh_evidence_incomplete",
    evidence_refs: [],
  });
  assert.deepEqual(events.filter((event) => event === "fresh:cross_conductor_happy_paths"), ["fresh:cross_conductor_happy_paths"]);
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
  command.cases = command.cases.map((e2eCase) => ({
    ...e2eCase,
    deadline_at: e2eCase.case_id === "cross_conductor_happy_paths" ? aDeadline : bDeadline,
  }));
  const campaign = await runParallelBlackBoxE2ECampaign({
    command,
    ports: {
      ...ports(events),
      async waitForHumanAction({ e2eCase, root_issue_id: rootIssueId }) {
        events.push(`human:${e2eCase.case_id}`);
        if (e2eCase.case_id === "cross_conductor_happy_paths" && rootIssueId === "root-happy-a") {
          await new Promise(() => {});
        }
        return { human_action_issue_id: `action-${rootIssueId}` };
      },
    },
  });

  assert.equal(caseResult(campaign, "cross_conductor_happy_paths").status, "passed");
  assert.equal(events.indexOf("human:plan_rejection_and_supersession") <
    events.indexOf("fresh:same_conductor_preemption"), true);
});

test("parallel black-box Campaign makes an incomplete fresh snapshot incomplete without invoking a predicate", async () => {
  const events = [];
  const campaign = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports(events, { snapshotKind: "incomplete" }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(campaign.cases.map(({ status, reason_code, evidence_refs }) => ({ status, reason_code, evidence_refs })),
    Array(8).fill({ status: "incomplete", reason_code: "fresh_evidence_incomplete", evidence_refs: [] }));
  assert.deepEqual(events.filter((event) => event.startsWith("predicate:")), []);
});

test("parallel black-box Campaign maps a durable non-overlap to failed", async () => {
  const campaign = await runParallelBlackBoxE2ECampaign({
    command: campaignCommand(),
    ports: ports([], { startOffsetsByCaseId: { "happy-b": 10_000 } }),
    now: () => Date.parse(now),
  });

  assert.deepEqual(caseResult(campaign, "cross_conductor_happy_paths"), {
    case_id: "cross_conductor_happy_paths",
    status: "failed",
    reason_code: "happy_path_overlap_absent",
    evidence_refs: ["linear:root-happy-a", "linear:root-happy-b", "git:repository-a", "git:repository-b"],
    observed_at: now,
  });
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
  assert.throws(
    () => getParallelBlackBoxE2ECampaignExitCode({
      ...command,
      cases: command.cases.map((e2eCase) => ({ ...e2eCase, mandatory: false })),
    }, result),
    /parallel_black_box_campaign_registry_invalid/u,
  );
});

test("parallel black-box Campaign exit code fails when a mandatory Case is incomplete", async () => {
  const command = campaignCommand();
  const result = await runParallelBlackBoxE2ECampaign({
    command,
    ports: ports([], { snapshotKind: "incomplete" }),
    now: () => Date.parse(now),
  });

  assert.equal(getParallelBlackBoxE2ECampaignExitCode(command, result), 1);
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
    cases: createMandatoryParallelBlackBoxCases({
      conductor_ids: ["conductor-a", "conductor-b", "conductor-c"],
      deadline_at: deadline,
    }),
  };
}

function changeCase(command, caseId, changes) {
  return {
    ...command,
    cases: command.cases.map((e2eCase) => e2eCase.case_id === caseId ? { ...e2eCase, ...changes } : e2eCase),
  };
}

function caseResult(result, caseId) {
  const entry = result.cases.find((candidate) => candidate.case_id === caseId);
  return entry ? { ...entry, observed_at: now } : entry;
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
      if (e2eCase.case_id === "cross_conductor_happy_paths") {
        return { root_issue_ids: ["root-happy-a", "root-happy-b"] };
      }
      if (e2eCase.human_script_id === "preempt_same_priority") {
        return { root_issue_ids: ["root-inflight", "root-updated"] };
      }
      if (e2eCase.human_script_id === "reject_plan") {
        return { root_issue_ids: ["root-plan-rejection"] };
      }
      if (e2eCase.human_script_id === "revise_root") {
        return { root_issue_ids: ["root-revision"] };
      }
      if (e2eCase.human_script_id === "restart_conductor") {
        return { root_issue_ids: ["root-restart-c", "root-restart-a", "root-restart-b"] };
      }
      if (e2eCase.human_script_id === "required_write_outage") {
        return { root_issue_ids: ["root-required-write"] };
      }
      if (e2eCase.human_script_id === "exhaust_cycle_budget") {
        return { root_issue_ids: ["root-cycle-exhaustion"] };
      }
      return { root_issue_ids: [`root-${e2eCase.case_id}`] };
    },
    human: {
      async readActorId() { return "human-actor"; },
      async readSymphonyActorId() { return "symphony-actor"; },
      async resolveHumanAction({ human_action_issue_id: actionIssueId, terminal_status: terminalStatus }) {
        if (terminalStatus === "rejected") events.push(`human-reject:${actionIssueId}`);
        const caseId = actionIssueId.startsWith("action-root-happy-")
          ? "cross_conductor_happy_paths"
          : actionIssueId.slice("action-".length);
        if (caseId === rejectCaseId) throw new Error("external failure");
      },
      async updateRoot({ root_issue_id: rootIssueId }) {
        if (rootIssueId === "root-revision") events.push(`human-revision:update:${rootIssueId}`);
        events.push(`human-update:${rootIssueId}`);
      },
      async createComment({ issue_id: issueId }) {
        events.push(`human-revision:create:${issueId}`);
        return { comment_id: "comment-revision" };
      },
      async editComment({ comment_id: commentId }) {
        events.push(`human-revision:edit:${commentId}`);
      },
      async resolveCommentThread({ thread_root_comment_id: commentId }) {
        events.push(`human-revision:resolve:${commentId}`);
      },
      async reopenCommentThread({ thread_root_comment_id: commentId }) {
        events.push(`human-revision:reopen:${commentId}`);
      },
    },
    async waitForRootReconcilerReply({ comment_id: commentId, thread_state: threadState }) {
      events.push(`human-revision:wait:${threadState}:${commentId}`);
    },
    async waitForHumanAction({ e2eCase, root_issue_id: rootIssueId, action_kind: actionKind }) {
      events.push(`human:${e2eCase.case_id}`);
      const expectedRootIssueIds = e2eCase.case_id === "cross_conductor_happy_paths"
        ? ["root-happy-a", "root-happy-b"]
        : [e2eCase.human_script_id === "required_write_outage" ? "root-required-write" :
          e2eCase.human_script_id === "exhaust_cycle_budget" ? "root-cycle-exhaustion" :
          e2eCase.human_script_id === "reject_plan" ? "root-plan-rejection" : `root-${e2eCase.case_id}`];
      assert.equal(expectedRootIssueIds.includes(rootIssueId), true);
      assert.equal(actionKind, "plan_review");
      return { human_action_issue_id: e2eCase.case_id === "cross_conductor_happy_paths"
        ? `action-${rootIssueId}`
        : `action-${e2eCase.case_id}` };
    },
    async waitForInFlightStage({ e2eCase, root_issue_id: rootIssueId }) {
      if (e2eCase.human_script_id === "restart_conductor") {
        assert.equal(rootIssueId, "root-restart-c");
        return { stage_execution_id: "execution-c-before-restart" };
      }
      assert.equal(e2eCase.human_script_id, "preempt_same_priority");
      assert.equal(rootIssueId, "root-inflight");
      return { stage_execution_id: "execution-inflight" };
    },
    async restartConductor({ caseContext, e2eCase, root_issue_id: rootIssueId }) {
      assert.equal(e2eCase.human_script_id, "restart_conductor");
      assert.deepEqual(caseContext.conductors.map(({ conductor_id: conductorId }) => conductorId), [
        "conductor-c", "conductor-a", "conductor-b",
      ]);
      assert.equal(rootIssueId, "root-restart-c");
      events.push("restart:conductor-c:root-restart-c");
    },
    async waitForRequiredWriteOutage({ e2eCase, root_issue_id: rootIssueId }) {
      assert.equal(e2eCase.human_script_id, "required_write_outage");
      assert.equal(rootIssueId, "root-required-write");
      events.push(`required-write:wait:${rootIssueId}`);
    },
    async restoreRequiredWriteOutage({ e2eCase, root_issue_id: rootIssueId }) {
      assert.equal(e2eCase.human_script_id, "required_write_outage");
      assert.equal(rootIssueId, "root-required-write");
      events.push(`required-write:restore:${rootIssueId}`);
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
      if (e2eCase.evidence_predicate_id === "plan_rejection_supersession") {
        const fixture = planRejectionSupersessionRow();
        assert.deepEqual(caseRoots, fixture.caseRoots);
        return fixture.snapshot;
      }
      if (e2eCase.evidence_predicate_id === "root_revision_comment") {
        const fixture = rootRevisionCommentRow();
        assert.deepEqual(caseRoots, fixture.caseRoots);
        return fixture.snapshot;
      }
      if (e2eCase.evidence_predicate_id === "restart_isolation") {
        const fixture = restartIsolationRow();
        assert.deepEqual(caseRoots, fixture.caseRoots);
        return fixture.snapshot;
      }
      if (e2eCase.evidence_predicate_id === "cycle_successor") {
        const fixture = cycleSuccessorRow();
        assert.deepEqual(caseRoots, fixture.caseRoots);
        return fixture.snapshot;
      }
      if (e2eCase.evidence_predicate_id === "required_write_fail_closed") {
        const fixture = requiredWriteOutageRow();
        assert.deepEqual(caseRoots, fixture.caseRoots);
        return fixture.snapshot;
      }
      if (e2eCase.evidence_predicate_id === "happy_path") {
        const a = happyPathRow({
          caseId: "happy-a",
          conductorId: "conductor-a",
          repositoryIdentity: "repository-a",
          startOffset: startOffsetsByCaseId["happy-a"] ?? 0,
        });
        const b = happyPathRow({
          caseId: "happy-b",
          conductorId: "conductor-b",
          repositoryIdentity: "repository-b",
          startOffset: startOffsetsByCaseId["happy-b"] ?? 0,
        });
        assert.deepEqual(caseRoots, { root_issue_ids: ["root-happy-a", "root-happy-b"] });
        return {
          kind: "complete",
          observed_at: now,
          root_trees: [...a.snapshot.root_trees, ...b.snapshot.root_trees],
          repositories: [...a.snapshot.repositories, ...b.snapshot.repositories],
        };
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
