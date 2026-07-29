import assert from "node:assert/strict";
import test from "node:test";

import {
  createForegroundE2EHumanActor as createActor,
  createHumanLinearRequestBudget,
  HUMAN_ACTION_POLL_INTERVAL_MS,
  HUMAN_LINEAR_REQUEST_INTERVAL_MS,
} from "../../tools/e2e/human.mjs";
import { FOREGROUND_E2E_CASES } from "../../tools/e2e/cases.mjs";

const immediateBudget = Object.freeze({ execute: (operation) => Promise.resolve().then(operation) });
const actor = (fixture, input = {}) => createActor({
  apiKey: "human-api-key",
  expectedActorId: "human-1",
  delegateActorId: "symphony-1",
  createClient: () => fixture.client,
  requestBudget: immediateBudget,
  ...input,
});

test("Human Actor uses stable polling and globally serialized Linear request budgets", async () => {
  assert.equal(HUMAN_ACTION_POLL_INTERVAL_MS, 5_000);
  assert.equal(HUMAN_LINEAR_REQUEST_INTERVAL_MS, 1_500);
  let now = 0;
  let release;
  const starts = [];
  const budget = createHumanLinearRequestBudget({
    now: () => now,
    wait: async (milliseconds) => { now += milliseconds; },
  });
  const first = budget.execute(async () => {
    starts.push(now);
    await new Promise((resolve) => { release = resolve; });
  });
  const second = budget.execute(async () => { starts.push(now); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(starts, [0, HUMAN_LINEAR_REQUEST_INTERVAL_MS]);
});

test("Human Actor resolves one Root kind label into every Case creation binding", async () => {
  const human = await actor(linearFixture());
  const bindings = await human.resolveRootCreationBindings({
    teamId: "team-1",
    projectId: "project-1",
    conductors: [
      conductorBinding("conductor-a", "aaa111aaa111"),
      conductorBinding("conductor-b", "bbb222bbb222"),
      conductorBinding("conductor-c", "ccc333ccc333"),
    ],
  });

  assert.equal(Object.values(bindings).length > 8, true);
  assert.equal(Object.values(bindings).every(({ rootLabelId }) => rootLabelId === "root-label"), true);
  assert.equal(bindings["approved-root"].routingLabelId, "route-aaa111aaa111");
});

test("Human Actor resolves one focused Root binding for one Conductor", async () => {
  const human = await actor(linearFixture());
  const binding = await human.resolveFocusedRootCreationBinding({
    rootKey: "approved-root",
    teamId: "team-1",
    projectId: "project-1",
    conductor: conductorBinding("conductor-a", "aaa111aaa111"),
  });

  assert.deepEqual(binding, {
    teamId: "team-1",
    projectId: "project-1",
    rootLabelId: "root-label",
    routingLabelId: "route-aaa111aaa111",
    rootStatusId: "todo-state",
    conductorId: "conductor-a-id",
    performerProfileId: "conductor-a-profile",
    worktreeDirectory: "/tmp/conductor-a",
  });
  await assert.rejects(
    human.resolveFocusedRootCreationBinding({
      rootKey: "not-a-catalog-root",
      teamId: "team-1",
      projectId: "project-1",
      conductor: conductorBinding("conductor-a", "aaa111aaa111"),
    }),
    hasCode("foreground_e2e_human_root_binding_input_invalid"),
  );
});

test("Human Actor admits every declared Root through one bounded batch lifecycle", async () => {
  const fixture = linearFixture();
  let budgetedRequests = 0;
  const requestBudget = Object.freeze({
    execute: async (operation) => {
      budgetedRequests += 1;
      return operation();
    },
  });
  const human = await actor(fixture, { delegateActorId: "symphony-1", requestBudget });
  const progress = [];

  const admission = await human.admitRootIssues({
    rootCreationsByRootKey: allRootCreationBindings(),
    onProgress: (event) => progress.push(event),
  });

  const rootKeys = FOREGROUND_E2E_CASES.flatMap(({ rootTopology }) => rootTopology.map(({ rootKey }) => rootKey));
  assert.equal(rootKeys.length, 14);
  assert.deepEqual(Object.keys(admission.rootsByKey), rootKeys);
  assert.equal(Object.values(admission.rootsByKey).every(({ rootIssueId, identifier }) =>
    typeof rootIssueId === "string" && typeof identifier === "string"), true);
  assert.equal(fixture.calls.createIssueBatch.length, 1);
  assert.equal(fixture.calls.createIssueBatch[0].issues.length, rootKeys.length);
  assert.deepEqual(fixture.calls.updateIssueBatch, [{
    issueIds: Object.values(admission.rootsByKey).map(({ rootIssueId }) => rootIssueId),
    input: { delegateId: "symphony-1" },
  }]);
  assert.deepEqual(fixture.calls.admission, [
    "create-roots",
    "read-roots",
    "read-children",
    "read-comments",
    "delegate-roots",
    "read-roots",
  ]);
  assert.deepEqual(progress, [
    { milestone: "roots-created", rootCount: 14 },
    { milestone: "roots-verified", rootCount: 14 },
    { milestone: "roots-delegated", rootCount: 14 },
  ]);
  assert.equal(budgetedRequests, 6);
});

test("Human Actor admits one catalog Root for focused real-boundary diagnosis", async () => {
  const fixture = linearFixture();
  const human = await actor(fixture, { delegateActorId: "symphony-1" });
  const binding = allRootCreationBindings()["approved-root"];

  const admission = await human.admitRootIssues({
    rootCreationsByRootKey: { "approved-root": binding },
  });

  assert.deepEqual(Object.keys(admission.rootsByKey), ["approved-root"]);
  assert.equal(fixture.calls.createIssueBatch.length, 1);
  assert.equal(fixture.calls.createIssueBatch[0].issues.length, 1);
  assert.deepEqual(fixture.calls.updateIssueBatch, [{
    issueIds: [admission.rootsByKey["approved-root"].rootIssueId],
    input: { delegateId: "symphony-1" },
  }]);
});

test("Human Actor waits for an exact Plan Approval Root thread and writes only a native human reply", async () => {
  const fixture = linearFixture();
  const human = await actor(fixture);
  const root = await admittedRoot(human, "approved-root");
  fixture.addPlanApproval(root.rootIssueId, { cycleId: "cycle-1", planId: "plan-1", planIdentifier: "ENG-PLAN-1", requestId: "approval-1" });

  const request = await human.waitForPlanApprovalRequest({ rootIssueId: root.rootIssueId });
  assert.deepEqual(request, {
    cycleIssueId: "cycle-1",
    planIssueId: "plan-1",
    planRemoteVersion: "2026-07-26T00:00:00.000Z",
    requestCommentId: "approval-1",
  });

  const reply = await human.replyToHumanAction({
    rootIssueId: root.rootIssueId,
    requestCommentId: request.requestCommentId,
    body: "Approved.",
  });
  assert.equal(reply.requestCommentId, "approval-1");
  assert.deepEqual(fixture.calls.createComment.at(-1), {
    issueId: root.rootIssueId,
    parentId: "approval-1",
    body: "Approved.",
  });
  assert.equal(fixture.calls.updateIssue.length, 0);
});

test("Human Actor ignores resolved approval history and rejects human-authored requests", async () => {
  const fixture = linearFixture();
  const human = await actor(fixture);
  const root = await admittedRoot(human, "rejected-plan-root");
  fixture.addPlanApproval(root.rootIssueId, {
    cycleId: "cycle-old", planId: "plan-old", planIdentifier: "ENG-OLD", requestId: "approval-old", resolved: true,
  });
  fixture.addPlanApproval(root.rootIssueId, {
    cycleId: "cycle-new", planId: "plan-new", planIdentifier: "ENG-NEW", requestId: "approval-new",
  });
  assert.equal((await human.waitForPlanApprovalRequest({ rootIssueId: root.rootIssueId })).requestCommentId, "approval-new");

  fixture.comments.get("approval-new").userId = "human-1";
  await assert.rejects(
    human.replyToHumanAction({ rootIssueId: root.rootIssueId, requestCommentId: "approval-new", body: "Approved." }),
    hasCode("foreground_e2e_human_action_reply_target_invalid"),
  );
});

test("Human Actor reads Information requests and observes native human-readable receipts", async () => {
  const fixture = linearFixture();
  const human = await actor(fixture);
  const root = await admittedRoot(human, "information-root");
  fixture.addProductComment(root.rootIssueId, "information-1", "## 需要你补充信息\n\nWhich separator should be used?");
  assert.deepEqual(await human.waitForInformationRequest({ rootIssueId: root.rootIssueId }), {
    requestCommentId: "information-1",
    rootIssueId: root.rootIssueId,
  });

  const answer = await human.replyToHumanAction({
    rootIssueId: root.rootIssueId,
    requestCommentId: "information-1",
    body: "Use a colon.",
  });
  fixture.addProductReply(answer.commentId, "receipt-1", "I incorporated the separator into the Root requirement.", "✅");
  await human.waitForCommentReceipt({ issueId: root.rootIssueId, inputReference: answer.inputReference });
});

test("Human Actor observes preemption and restart admission from native Stage statuses and Activity", async () => {
  const fixture = linearFixture();
  const human = await actor(fixture);
  const admitted = await admitRoots(human);
  const ids = Object.fromEntries(["inflight-root", "touched-root", "remaining-root"]
    .map((key) => [key, admitted[key].rootIssueId]));
  fixture.addStage(ids["inflight-root"], "stage-old", "work", "in-progress-state", "2026-07-26T00:00:01.000Z");
  const admission = await human.waitForSameConductorPreemptionAdmission({ rootIssueIds: Object.values(ids) });
  assert.equal(admission.inflightStageIssueId, "stage-old");

  await human.updateRootDescription({
    rootIssueId: ids["touched-root"],
    description: "Implement a small marker helper with focused tests. Scheduling note: this request remains semantically unchanged.",
  });
  fixture.setStageStatus("stage-old", "done-state", "2026-07-26T00:00:03.000Z");
  fixture.addStage(ids["touched-root"], "stage-touched", "plan", "in-progress-state", "2026-07-26T00:00:04.000Z");
  fixture.addStage(ids["remaining-root"], "stage-remaining", "plan", "in-progress-state", "2026-07-26T00:00:05.000Z");
  const candidate = await human.waitForSameConductorPreemptionCandidate({
    inflightStageIssueId: "stage-old",
    touchedRootIssueId: ids["touched-root"],
    remainingRootIssueId: ids["remaining-root"],
  });
  assert.deepEqual(candidate, { rootIssueId: ids["touched-root"], stageIssueId: "stage-touched", touchActivityId: "history-1" });

  const recoveryFixture = linearFixture();
  const recoveryHuman = await actor(recoveryFixture);
  const recoveryRoots = await admitRoots(recoveryHuman);
  const affected = recoveryRoots["affected-root"];
  const continuous = recoveryRoots["continuous-root"];
  recoveryFixture.addStage(affected.rootIssueId, "stage-interrupted", "work", "in-progress-state", "2026-07-26T00:00:01.000Z");
  assert.deepEqual(await recoveryHuman.waitForRestartRecoveryAdmission({
    affectedRootIssueId: affected.rootIssueId,
    continuousRootIssueId: continuous.rootIssueId,
  }), { affectedRootIssueId: affected.rootIssueId, interruptedStageIssueId: "stage-interrupted" });
});

test("Human Actor admits missing-worktree recovery only at each declared Root's native active Verify", async () => {
  const fixture = linearFixture();
  const human = await actor(fixture);
  const admitted = await admitRoots(human);
  const recoverable = admitted["recoverable-worktree-root"];
  const invalid = admitted["invalid-generation-root"];
  fixture.addStage(recoverable.rootIssueId, "verify-recoverable", "verify", "in-progress-state", "2026-07-26T00:00:01.000Z");
  fixture.addStage(invalid.rootIssueId, "verify-invalid", "verify", "in-progress-state", "2026-07-26T00:00:02.000Z");

  assert.deepEqual(await human.waitForMissingWorktreeRecoveryAdmission({
    rootIssueIds: [recoverable.rootIssueId, invalid.rootIssueId],
  }), {
    verifyIssueIdsByRootId: {
      [recoverable.rootIssueId]: "verify-recoverable",
      [invalid.rootIssueId]: "verify-invalid",
    },
    nativeIssueIdsByRootId: {
      [recoverable.rootIssueId]: [recoverable.rootIssueId, `${recoverable.rootIssueId}-cycle`, "verify-recoverable"],
      [invalid.rootIssueId]: [invalid.rootIssueId, `${invalid.rootIssueId}-cycle`, "verify-invalid"],
    },
  });
  await assert.rejects(
    human.waitForMissingWorktreeRecoveryAdmission({ rootIssueIds: [recoverable.rootIssueId, recoverable.rootIssueId] }),
    hasCode("foreground_e2e_human_missing_worktree_admission_input_invalid"),
  );
});

test("Human Actor public surface contains no product workflow mutation", async () => {
  const human = await actor(linearFixture());
  assert.equal("setHumanActionTerminalStatus" in human, false);
  assert.equal("createHumanAction" in human, false);
  assert.equal(["write", "Managed", "Record"].join("") in human, false);
  assert.equal("mutatePlan" in human, false);
  assert.equal("createRootIssue" in human, false);
  assert.equal("assertRootUndelegatedAndInactive" in human, false);
  assert.equal("delegateRootIssue" in human, false);
  assert.equal("client" in human, false);
  assert.equal(typeof human.replyToHumanAction, "function");
});

async function admittedRoot(human, rootKey) {
  return (await admitRoots(human))[rootKey];
}

async function admitRoots(human) {
  return (await human.admitRootIssues({ rootCreationsByRootKey: allRootCreationBindings() })).rootsByKey;
}

function linearFixture() {
  const calls = {
    createIssue: [],
    createIssueBatch: [],
    updateIssue: [],
    updateIssueBatch: [],
    createComment: [],
    admission: [],
  };
  const issues = new Map();
  const comments = new Map();
  let rootSequence = 0;
  let commentSequence = 0;
  const statusNames = new Map([
    ["todo-state", "Todo"],
    ["in-review-state", "In Review"],
    ["in-progress-state", "In Progress"],
    ["done-state", "Done"],
  ]);

  const fixture = {
    calls,
    issues,
    comments,
    client: undefined,
    addProductComment(issueId, id, body, { resolved = false } = {}) {
      comments.set(id, makeComment({ id, issueId, body, userId: "symphony-1", resolved }));
    },
    addProductReply(parentId, id, body, receipt) {
      const source = comments.get(parentId);
      comments.set(id, makeComment({ id, issueId: source.issueId, parentId, body, userId: "symphony-1", updatedAt: "2026-07-26T00:00:10.000Z" }));
      source.children = async () => ({ nodes: [...comments.values()].filter((candidate) => candidate.parentId === parentId), pageInfo: { hasNextPage: false } });
      if (receipt) source.reactions.push({ id: `reaction-${id}`, emoji: receipt, userId: "symphony-1" });
    },
    addPlanApproval(rootIssueId, { cycleId, planId, planIdentifier, requestId, resolved = false }) {
      issues.set(cycleId, makeIssue({ id: cycleId, parentId: rootIssueId, labels: ["symphony:kind/cycle"], stateId: "todo-state" }));
      issues.set(planId, makeIssue({
        id: planId,
        identifier: planIdentifier,
        parentId: cycleId,
        labels: ["symphony:kind/plan"],
        stateId: "in-review-state",
        description: "Implement the requested behavior and run focused checks.",
      }));
      fixture.addProductComment(rootIssueId, requestId, `## 需要你审批\n\nPlease review ${planIdentifier}.\n\n### 相关对象\n- ${planIdentifier}`, { resolved });
    },
    addStage(rootIssueId, stageId, kind, stateId, changedAt) {
      const cycleId = `${rootIssueId}-cycle`;
      if (!issues.has(cycleId)) issues.set(cycleId, makeIssue({ id: cycleId, parentId: rootIssueId, labels: ["symphony:kind/cycle"], stateId: "todo-state" }));
      const stage = makeIssue({ id: stageId, parentId: cycleId, labels: [workflowKindLabel(kind)], stateId });
      stage.historyEntries.push(activity(stageId, stateId, changedAt));
      stage.updatedAt = new Date(changedAt);
      issues.set(stageId, stage);
    },
    setStageStatus(stageId, stateId, changedAt) {
      const stage = issues.get(stageId);
      stage.stateId = stateId;
      stage.updatedAt = new Date(changedAt);
      stage.historyEntries.push(activity(stageId, stateId, changedAt));
    },
  };

  fixture.client = {
    viewer: Promise.resolve({ id: "human-1" }),
    async createIssueBatch(input) {
      calls.createIssueBatch.push(input);
      calls.admission.push("create-roots");
      const created = input.issues.map((issueInput) => createFixtureRoot(issueInput));
      return { success: true, issues: created };
    },
    async updateIssueBatch(issueIds, input) {
      calls.updateIssueBatch.push({ issueIds, input });
      calls.admission.push("delegate-roots");
      const updated = issueIds.map((issueId) => {
        const issue = issues.get(issueId);
        Object.assign(issue, input);
        return issue;
      });
      return { success: true, issues: updated };
    },
    async issues({ filter }) {
      if (filter?.id?.in) {
        calls.admission.push("read-roots");
        return connection(filter.id.in.map((issueId) => issues.get(issueId)).filter(Boolean));
      }
      if (filter?.parent?.id?.in) {
        calls.admission.push("read-children");
        const parents = new Set(filter.parent.id.in);
        return connection([...issues.values()].filter(({ parentId }) => parents.has(parentId)));
      }
      return connection([]);
    },
    async comments({ filter }) {
      calls.admission.push("read-comments");
      const issueIds = new Set(filter?.issue?.id?.in ?? []);
      return connection([...comments.values()].filter(({ issueId }) => issueIds.has(issueId)));
    },
    async createIssue(input) {
      calls.createIssue.push(input);
      const issue = createFixtureRoot(input);
      return { success: true, issueId: issue.id };
    },
    async updateIssue(issueId, input) {
      calls.updateIssue.push({ issueId, input });
      const issue = issues.get(issueId);
      if (!issue) return { success: false };
      Object.assign(issue, input);
      issue.updatedAt = new Date("2026-07-26T00:00:02.000Z");
      if (input.description !== undefined) issue.historyEntries.push({
        ...activity(issueId, issue.stateId, "2026-07-26T00:00:02.000Z"),
        id: `history-${issue.historyEntries.length + 1}`,
        actorId: "human-1",
        updatedDescription: true,
      });
      return { success: true, issueId };
    },
    async issue(id) { return issues.get(id); },
    async comment({ id }) { return comments.get(id); },
    async createComment(input) {
      calls.createComment.push(input);
      commentSequence += 1;
      const id = `human-comment-${commentSequence}`;
      const created = makeComment({ id, issueId: input.issueId, parentId: input.parentId, body: input.body, userId: "human-1" });
      created.children = async () => ({ nodes: [...comments.values()].filter((candidate) => candidate.parentId === id), pageInfo: { hasNextPage: false } });
      comments.set(id, created);
      return { success: true, commentId: id, comment: Promise.resolve(created) };
    },
    async updateComment(id, input) {
      Object.assign(comments.get(id), input, { updatedAt: new Date("2026-07-26T00:00:02.000Z") });
      return { success: true, commentId: id };
    },
    async commentResolve(id) { comments.get(id).resolvedAt = new Date(); return { success: true, commentId: id }; },
    async commentUnresolve(id) { comments.get(id).resolvedAt = undefined; return { success: true, commentId: id }; },
    async createReaction({ commentId, emoji }) {
      comments.get(commentId).reactions.push({ id: "human-reaction", emoji, userId: "human-1" });
      return { success: true, reactionId: "human-reaction" };
    },
    async team(id) {
      return {
        id,
        async states() {
          return {
            nodes: [...statusNames].map(([stateId, name]) => ({ id: stateId, name, type: name === "Todo" ? "unstarted" : "started", archivedAt: null })),
            pageInfo: { hasNextPage: false },
          };
        },
      };
    },
    async issueLabels({ filter }) {
      const name = filter.name.eq;
      const routeHash = name.match(/^symphony:conductor\/([a-f0-9]{12})$/u)?.[1];
      return { nodes: [{ id: name === "symphony:kind/root" ? "root-label" : routeHash ? `route-${routeHash}` : "route-label", name, isGroup: false, archivedAt: null, teamId: "team-1" }], pageInfo: { hasNextPage: false } };
    },
  };

  function createFixtureRoot(input) {
    rootSequence += 1;
    const id = `root-${rootSequence}`;
    const issue = makeIssue({
      id,
      identifier: `ENG-${rootSequence}`,
      labels: input.labelIds.map((labelId) => labelId === "root-label" ? "symphony:kind/root" : "symphony:conductor/abc123def456"),
      labelIds: input.labelIds,
      stateId: input.stateId,
      title: input.title,
      description: input.description,
      priority: input.priority,
    });
    issues.set(id, issue);
    return issue;
  }

  function makeIssue({ id, identifier, parentId, labels, labelIds, stateId, title = id, description = "Product-created native Issue.", priority = 2 }) {
    const issue = {
      id, identifier, parentId, labelsValue: labels, labelIds: labelIds ?? labels, stateId, title, description, priority,
      teamId: "team-1", projectId: "project-1", creatorId: "symphony-1", delegateId: undefined,
      updatedAt: new Date("2026-07-26T00:00:00.000Z"), historyEntries: [],
      async labels() { return { nodes: this.labelsValue.map((name) => ({ id: name === "symphony:conductor/abc123def456" ? "route-label" : name === "symphony:kind/root" ? "root-label" : `${name.toLowerCase()}-label`, name })), pageInfo: { hasNextPage: false } }; },
      async children() { return { nodes: [...issues.values()].filter((candidate) => candidate.parentId === this.id), pageInfo: { hasNextPage: false } }; },
      async comments() { return { nodes: [...comments.values()].filter((candidate) => candidate.issueId === this.id && !candidate.parentId), pageInfo: { hasNextPage: false } }; },
      async history() { return { nodes: this.historyEntries, pageInfo: { hasNextPage: false } }; },
    };
    return issue;
  }
  return fixture;
}

function allRootCreationBindings() {
  return Object.fromEntries(FOREGROUND_E2E_CASES.flatMap(({ rootTopology }) => rootTopology.map(({ rootKey }) => [rootKey, {
    teamId: "team-1",
    projectId: "project-1",
    rootLabelId: "root-label",
    routingLabelId: "route-label",
    rootStatusId: "todo-state",
    conductorId: "conductor-a",
    performerProfileId: "profile-a",
    worktreeDirectory: "/tmp/conductor-a",
  }])));
}

function connection(nodes) {
  return { nodes, pageInfo: { hasNextPage: false } };
}

function conductorBinding(conductorRef, conductorShortHash) {
  return {
    conductorRef,
    conductorShortHash,
    conductorId: `${conductorRef}-id`,
    performerProfileId: `${conductorRef}-profile`,
    worktreeDirectory: `/tmp/${conductorRef}`,
  };
}

function makeComment({ id, issueId, body, userId, parentId, resolved = false, updatedAt = "2026-07-26T00:00:00.000Z" }) {
  return {
    id, issueId, body, userId, parentId,
    createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt), resolvedAt: resolved ? new Date(updatedAt) : undefined, reactions: [],
    async children() { return { nodes: [], pageInfo: { hasNextPage: false } }; },
  };
}

function activity(issueId, toStateId, at) {
  return { id: `activity-${issueId}-${toStateId}`, issueId, actorId: "symphony-1", toStateId, createdAt: new Date(at), updatedAt: new Date(at) };
}

function workflowKindLabel(kind) {
  const label = {
    plan: "symphony:kind/plan",
    work: "symphony:kind/work",
    verify: "symphony:kind/verify",
  }[kind];
  if (!label) throw new Error(`unsupported workflow kind: ${kind}`);
  return label;
}

function hasCode(code) {
  return (error) => error?.code === code;
}
