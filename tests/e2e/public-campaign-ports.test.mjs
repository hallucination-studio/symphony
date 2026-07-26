import assert from "node:assert/strict";
import test from "node:test";

import { createPublicParallelBlackBoxCampaignPorts } from "../../tools/e2e/public-campaign-ports.mjs";

const repositoryContexts = Object.freeze([
  Object.freeze({ repository_identity: "repository-a", repository_root: "/repo/a", base_branch: "main" }),
  Object.freeze({ repository_identity: "repository-b", repository_root: "/repo/b", base_branch: "main" }),
  Object.freeze({ repository_identity: "repository-c", repository_root: "/repo/c", base_branch: "main" }),
]);

test("public Campaign ports create routed Roots, sequence Human actions from fresh observations, and retain final snapshot ownership", async () => {
  const calls = [];
  let rootNumber = 0;
  const requiredWriteOutage = {
    arm(input) { calls.push({ kind: "arm", ...input }); },
    async waitUntilBlocked(input) { calls.push({ kind: "wait-outage", ...input }); },
    restore(input) { calls.push({ kind: "restore-outage", ...input }); },
  };
  const ports = createPublicParallelBlackBoxCampaignPorts({
    human: {
      async createRoot(input) {
        calls.push({ kind: "create-root", input });
        rootNumber += 1;
        return { root_issue_id: `root-${rootNumber}` };
      },
    },
    project_id: "project-1",
    routing: {
      team_id: "team-1",
      routing_labels: [
        { conductor_short_hash: "abcdef123456", label_id: "label-a" },
        { conductor_short_hash: "abcdef123457", label_id: "label-b" },
        { conductor_short_hash: "abcdef123458", label_id: "label-c" },
      ],
    },
    repository_contexts: repositoryContexts,
    required_write_outage: requiredWriteOutage,
    restart_conductor: async (conductorId) => { calls.push({ kind: "restart", conductorId }); },
    readFreshEvidenceSnapshot: async ({ root_issue_ids: rootIssueIds, repository_contexts: contexts }) => {
      calls.push({ kind: "fresh", rootIssueIds, contexts });
      return snapshot(rootIssueIds[0]);
    },
    now: () => new Date("2026-07-26T00:00:00.000Z"),
    wait: async () => { throw new Error("unexpected wait"); },
  });

  const happyContext = context([conductor("a"), conductor("b")]);
  const happyCase = e2eCase("cross_conductor_happy_paths", "approve_plan", "happy_path", ["conductor-a", "conductor-b"]);
  const happyRoots = await ports.createCaseRoots({ caseContext: happyContext, e2eCase: happyCase });
  assert.deepEqual(happyRoots, { root_issue_ids: ["root-1", "root-2"] });
  assert.deepEqual(calls.slice(0, 2).map(({ input }) => ({
    projectId: input.project_id,
    teamId: input.team_id,
    labels: input.routing_label_ids,
  })), [
    { projectId: "project-1", teamId: "team-1", labels: ["label-a"] },
    { projectId: "project-1", teamId: "team-1", labels: ["label-b"] },
  ]);

  assert.deepEqual(
    await ports.waitForHumanAction({ caseContext: context([conductor("a")]), e2eCase: e2eCase("delivery_and_review", "deliver_and_review", "delivery_review", ["conductor-a"]), root_issue_id: "root-action", action_kind: "plan_review" }),
    { human_action_issue_id: "action-plan" },
  );
  assert.deepEqual(
    await ports.waitForInFlightStage({ caseContext: context([conductor("a")]), e2eCase: e2eCase("same_conductor_preemption", "preempt_same_priority", "same_conductor_preemption", ["conductor-a"]), root_issue_id: "root-stage" }),
    { stage_execution_id: "execution-1" },
  );
  await ports.waitForRootReconcilerReply({
    caseContext: context([conductor("a")]),
    e2eCase: e2eCase("root_revision_and_comment", "revise_root", "root_revision_comment", ["conductor-a"]),
    root_issue_id: "root-reply",
    comment_id: "comment-reply",
    thread_state: "resolved",
  });
  await ports.restartConductor({ caseContext: context([conductor("c"), conductor("a"), conductor("b")]), e2eCase: e2eCase("conductor_restart_isolation", "restart_conductor", "restart_isolation", ["conductor-c", "conductor-a", "conductor-b"]), root_issue_id: "root-restart" });

  const outageRoots = await ports.createCaseRoots({
    caseContext: context([conductor("a")]),
    e2eCase: e2eCase("required_linear_write_fail_closed", "required_write_outage", "required_write_fail_closed", ["conductor-a"]),
  });
  await ports.waitForRequiredWriteOutage({ root_issue_id: outageRoots.root_issue_ids[0] });
  await ports.restoreRequiredWriteOutage({ root_issue_id: outageRoots.root_issue_ids[0] });
  const finalSnapshot = await ports.readFreshEvidenceSnapshot({
    caseContext: happyContext,
    e2eCase: happyCase,
    caseRoots: happyRoots,
  });
  assert.equal(finalSnapshot.kind, "complete");
  assert.deepEqual(calls.filter(({ kind }) => kind === "restart"), [{ kind: "restart", conductorId: "conductor-c" }]);
  assert.deepEqual(calls.filter(({ kind }) => kind === "arm"), [{ kind: "arm", root_issue_id: "root-3" }]);
  assert.deepEqual(calls.filter(({ kind }) => kind === "wait-outage"), [{ kind: "wait-outage", root_issue_id: "root-3" }]);
  assert.deepEqual(calls.filter(({ kind }) => kind === "restore-outage"), [{ kind: "restore-outage", root_issue_id: "root-3" }]);
  assert.equal(calls.filter(({ kind }) => kind === "fresh").every(({ contexts }) =>
    contexts.every((entry) => repositoryContexts.includes(entry))), true);
});

test("public Campaign ports propagate a final fresh-read failure for the single verdict boundary", async () => {
  const ports = createPublicParallelBlackBoxCampaignPorts({
    human: { async createRoot() { return { root_issue_id: "root-1" }; } },
    project_id: "project-1",
    routing: {
      team_id: "team-1",
      routing_labels: [
        { conductor_short_hash: "abcdef123456", label_id: "label-a" },
        { conductor_short_hash: "abcdef123457", label_id: "label-b" },
        { conductor_short_hash: "abcdef123458", label_id: "label-c" },
      ],
    },
    repository_contexts: repositoryContexts,
    required_write_outage: { arm() {}, async waitUntilBlocked() {}, restore() {} },
    restart_conductor: async () => {},
    readFreshEvidenceSnapshot: async () => { throw new Error("read failed"); },
  });

  await assert.rejects(
    ports.readFreshEvidenceSnapshot({
      caseContext: context([conductor("a")]),
      e2eCase: e2eCase("delivery_and_review", "deliver_and_review", "delivery_review", ["conductor-a"]),
      caseRoots: { root_issue_ids: ["root-1"] },
    }),
    /read failed/u,
  );
});

function snapshot(rootIssueId) {
  if (rootIssueId === "root-action") {
    return complete(rootIssueId, {
      issues: [{ issue_id: "action-plan", is_archived: false, status: { name: "Todo" }, labels: [{ name: "Human Action" }, { name: "Plan Review" }] }],
      managed_blocks: [{ record: { kind: "human_action_request", root_issue_id: rootIssueId, action_issue_id: "action-plan", action_kind: "plan_review" } }],
    });
  }
  if (rootIssueId === "root-stage") {
    return complete(rootIssueId, {
      issues: [],
      managed_blocks: [{ record: { kind: "stage_execution", root_issue_id: rootIssueId, stage_execution_id: "execution-1" } }],
    });
  }
  if (rootIssueId === "root-reply") {
    return complete(rootIssueId, {
      issues: [],
      comments: [{ comment_id: "comment-reply", thread_state: "resolved" }],
      managed_blocks: [{ record: {
        kind: "root_reconciler_reply",
        source: { kind: "comment_thread_state", comment_id: "comment-reply", thread_state: "resolved" },
      } }],
    });
  }
  return complete(rootIssueId, { issues: [], managed_blocks: [] });
}

function complete(rootIssueId, tree) {
  return {
    kind: "complete",
    observed_at: "2026-07-26T00:00:00.000Z",
    root_trees: [{ root_issue_id: rootIssueId, ...tree }],
    repositories: [],
  };
}

function conductor(suffix) {
  return {
    binding_id: `binding-${suffix}`,
    conductor_id: `conductor-${suffix}`,
    conductor_short_hash: `abcdef12345${suffix === "a" ? "6" : suffix === "b" ? "7" : "8"}`,
    repository_identity: `repository-${suffix}`,
  };
}

function context(conductors) {
  return {
    campaign_id: "campaign-1",
    project_id: "project-1",
    human_actor_id: "human-actor",
    symphony_actor_id: "symphony-actor",
    conductors,
  };
}

function e2eCase(case_id, human_script_id, evidence_predicate_id, routed_conductor_ids) {
  return {
    case_id,
    human_script_id,
    evidence_predicate_id,
    routed_conductor_ids,
    deadline_at: "2026-07-26T00:05:00.000Z",
  };
}
