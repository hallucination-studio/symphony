import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeRootAction,
  discoverV1Root,
  hashRootInput,
  hashWorkInput,
  parseHumanDescription,
  parseRootManagedComment,
  parseWorkDescription,
  reconcilePlan,
  selectWorkflowLeaf,
  type RootRunView,
  type WorkflowNode,
} from "../api/index.js";
import { FilePerformerProfileStoreImpl } from "../../performer-profiles/internal/FilePerformerProfileStoreImpl.js";

const root = {
  issueId: "root-1",
  identifier: "SYM-1",
  state: "In Progress" as const,
  title: "Build V1",
  description: "Follow the approved architecture.",
  updatedAt: "2026-07-16T00:00:00Z",
};

test("managed state parsers reject ambiguity and exclude metadata from hashes", () => {
  const parsed = parseRootManagedComment(`Symphony Root Run
conductor_id: conductor-1
performer_profile_id: profile-1
performer_id: conversation-1
planned_root_input_hash: hash-1
usage_input_tokens: 0
usage_cached_input_tokens: 0
usage_output_tokens: 0
usage_reasoning_output_tokens: 0
usage_total_tokens: 0
last_usage_turn_id: none
delivery_branch: symphony/runs/sym-1
pull_request: none
last_error: none
turn_id: turn-1
turn_status: analyzing
turn_event_sequence: 3
turn_status_updated_at: 2026-07-16T00:00:01Z
<!-- symphony root marker -->`);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.performerProfileId, "profile-1");
  assert.deepEqual({
    turnId: parsed.value.turnId,
    turnStatus: parsed.value.turnStatus,
    turnEventSequence: parsed.value.turnEventSequence,
    turnStatusUpdatedAt: parsed.value.turnStatusUpdatedAt,
  }, {
    turnId: "turn-1",
    turnStatus: "analyzing",
    turnEventSequence: 3,
    turnStatusUpdatedAt: "2026-07-16T00:00:01Z",
  });

  const work = parseWorkDescription(`Business requirement.

<!-- symphony work metadata
kind: work
origin: user
completed_input_hash: prior-hash
-->`);
  assert.equal(work.ok, true);
  if (!work.ok) return;
  assert.equal(work.value.businessDescription, "Business requirement.");
  assert.deepEqual(
    parseWorkDescription(`Generated work.

<!-- symphony managed marker
managed_marker: root-1:plan:work-1
-->

<!-- symphony work metadata
kind: work
origin: symphony
completed_input_hash: none
-->`),
    {
      ok: true,
      value: {
        businessDescription: "Generated work.",
        managedMarker: "root-1:plan:work-1",
        origin: "symphony",
      },
    },
  );
  assert.equal(
    hashWorkInput(root, {
      identifier: "SYM-2",
      title: "Implement",
      description: work.value.businessDescription,
      humanInputs: [],
      isLeaf: true,
    }),
    hashWorkInput(root, {
      identifier: "SYM-2",
      title: "Implement",
      description: "Business requirement.",
      humanInputs: [],
      isLeaf: true,
    }),
  );
  assert.deepEqual(
    parseWorkDescription(`Business
<!-- symphony work metadata
kind: broken
-->`),
    { ok: false, error: "work_managed_metadata_invalid" },
  );
  assert.deepEqual(
    parseHumanDescription(`Approve this plan.

<!-- symphony managed marker
managed_marker: root-1:plan-approval
kind: human
human_kind: plan_approval
target_issue_id: none
-->`),
    {
      ok: true,
      value: {
        businessDescription: "Approve this plan.",
        managedMarker: "root-1:plan-approval",
        humanKind: "plan_approval",
      },
    },
  );
});

test("Tree traversal selects the first deepest incomplete leaf in Linear order", () => {
  const nodes: WorkflowNode[] = [
    node("group", null, 1, "work", "Todo"),
    node("later", null, 2, "work", "Todo"),
    node("human", "group", 1, "human", "Done", {
      humanKind: "planned_input",
      answer: "approved input",
      targetIssueId: "deep",
    }),
    node("deep", "group", 2, "work", "Todo"),
  ];
  assert.deepEqual(selectWorkflowLeaf(nodes), {
    kind: "execute_work",
    nodeId: "deep",
  });

  const waiting = nodes.map((item) =>
    item.issueId === "human" ? { ...item, state: "In Progress" as const } : item,
  );
  assert.deepEqual(selectWorkflowLeaf(waiting), {
    kind: "wait_human",
    nodeId: "human",
  });
  assert.deepEqual(
    selectWorkflowLeaf([
      node("committed", null, 1, "work", "In Progress", {
        currentInputHash: "current",
        completedInputHash: "current",
      }),
    ]),
    { kind: "finalize_work", nodeId: "committed" },
  );
  assert.deepEqual(
    selectWorkflowLeaf([
      node("first", null, 1, "work", "Todo"),
      node("second", null, 1, "work", "Todo"),
    ]),
    { kind: "blocked_root", reason: "linear_sibling_order_ambiguous" },
  );
  assert.deepEqual(
    selectWorkflowLeaf([
      node("canceled-group", null, 1, "work", "Canceled"),
      node("ignored-active", "canceled-group", 1, "work", "In Progress"),
      node("current", null, 2, "work", "Todo"),
    ]),
    { kind: "execute_work", nodeId: "current" },
  );
});

test("V1 Root discovery resumes one owned Root or claims exactly one candidate", () => {
  const candidate = {
    ...root,
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
  };
  assert.deepEqual(
    discoverV1Root({
      project: { kind: "resolved", projectId: "project-1" },
      roots: [candidate],
      conductorId: "conductor-1",
    }),
    { kind: "claim_root", rootId: "root-1" },
  );
  assert.deepEqual(
    discoverV1Root({
      project: { kind: "resolved", projectId: "project-1" },
      roots: [candidate, { ...candidate, issueId: "root-2" }],
      conductorId: "conductor-1",
    }),
    { kind: "conductor_wait", reason: "multiple_eligible_roots" },
  );
});

test("RootAction replans Root changes, waits for approval, and never advances stale facts", () => {
  assert.deepEqual(
    computeRootAction({
      root: { ...root, state: "Todo" },
      conductorId: "conductor-1",
      resolvedProjectId: "project-1",
      phaseLabels: [],
      workflowNodes: [],
    }),
    { kind: "claim_root" },
  );
  const base: RootRunView = {
    root,
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    phaseLabels: ["planning"],
    managedComment: {
      conductorId: "conductor-1",
      performerProfileId: "profile-1",
      performerId: "conversation-1",
      plannedRootInputHash: hashRootInput(root),
      deliveryBranch: "symphony/runs/sym-1",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    },
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: [],
  };
  assert.deepEqual(computeRootAction(base), { kind: "plan_root" });

  const changed = {
    ...base,
    root: { ...root, title: "Changed title" },
    phaseLabels: ["working" as const],
  };
  assert.deepEqual(computeRootAction(changed), {
    kind: "plan_root",
    reason: "root_input_changed",
  });

  const waitingApproval: RootRunView = {
    ...base,
    phaseLabels: ["awaiting-human"],
    workflowNodes: [
      node("approval", null, 0, "human", "In Progress", {
        humanKind: "plan_approval",
      }),
      node("work", null, 1, "work", "Todo"),
    ],
  };
  assert.deepEqual(computeRootAction(waitingApproval), {
    kind: "wait_human",
    nodeId: "approval",
  });

  assert.deepEqual(
    computeRootAction({
      ...waitingApproval,
      phaseLabels: ["blocked"],
      workflowNodes: [
        { ...waitingApproval.workflowNodes[0]!, state: "Done" },
        waitingApproval.workflowNodes[1]!,
      ],
    }),
    { kind: "execute_work", nodeId: "work" },
  );
  assert.deepEqual(
    computeRootAction({
      ...waitingApproval,
      phaseLabels: [],
    }),
    { kind: "repair_root_phase", phase: "awaiting-human" },
  );
});

test("Plan reconciliation preserves user and completed nodes and reuses stable markers", () => {
  const current = [
    node("user-work", null, 1, "work", "Todo", { origin: "user" }),
    node("old-plan", null, 2, "work", "Todo", {
      origin: "symphony",
      managedMarker: "old",
    }),
    node("done-plan", null, 3, "work", "Done", {
      origin: "symphony",
      managedMarker: "done",
      completedInputHash: "hash",
    }),
  ];
  const result = reconcilePlan({
    rootIssueId: "root-1",
    turnInputHash: "turn-hash",
    summary: "Implement one work leaf.",
    current,
    planned: [
      {
        clientNodeKey: "user-work",
        kind: "work",
        order: 0,
        title: "Must not overwrite user work",
        description: "Ignored",
        existingIssueId: "user-work",
      },
      {
        clientNodeKey: "new-work",
        kind: "work",
        order: 1,
        title: "New work",
        description: "Do it",
      },
    ],
  });
  assert.equal(result.operations.some((item) => item.kind === "preserve" && item.issueId === "user-work"), true);
  assert.equal(result.operations.some((item) => item.kind === "update" && item.issueId === "user-work"), false);
  assert.equal(result.operations.some((item) => item.kind === "preserve" && item.issueId === "done-plan"), true);
  assert.equal(result.operations.some((item) => item.kind === "cancel" && item.issueId === "old-plan"), true);
  assert.equal(result.approval.title, "[Human Action] Approve Plan");
  assert.match(result.operations.find((item) => item.kind === "create")?.managedMarker ?? "", /root-1:turn-hash:new-work/);
  assert.throws(
    () =>
      reconcilePlan({
        rootIssueId: "root-1",
        turnInputHash: "hash",
        summary: "Cycle",
        current: [],
        planned: [
          {
            clientNodeKey: "a",
            parentClientNodeKey: "b",
            kind: "work",
            order: 1,
            title: "A",
            description: "",
          },
          {
            clientNodeKey: "b",
            parentClientNodeKey: "a",
            kind: "work",
            order: 2,
            title: "B",
            description: "",
          },
        ],
      }),
    /plan_tree_cycle/,
  );
});

test("Profile store atomically preserves fixed authentication and activates only ready Profiles", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "symphony-profiles-"));
  const store = new FilePerformerProfileStoreImpl(dataRoot);
  const created = await store.create({
    profileId: "profile-1",
    displayName: "Primary",
    backendKind: "codex",
    authenticationMethod: "api_key",
    codexTurnSettings: {
      model: "codex-model",
      reasoningEffort: "medium",
      isFastModeEnabled: false,
    },
    now: "2026-07-16T00:00:00Z",
  });
  await assert.rejects(
    store.update({
      profileId: created.profileId,
      displayName: "Changed",
      codexTurnSettings: {
        model: "codex-model",
        reasoningEffort: "medium",
        isFastModeEnabled: true,
      },
      now: "2026-07-16T00:01:00Z",
    }),
    /api_key_fast_unavailable/,
  );
  await assert.rejects(store.activate("profile-1", "login-required"), /profile_not_ready/);
  await store.activate("profile-1", "ready");

  const persisted = JSON.parse(
    await readFile(path.join(dataRoot, "performer-profiles", "profiles.json"), "utf8"),
  );
  assert.equal(persisted.activeProfileId, "profile-1");
  assert.equal("apiKey" in persisted.profiles[0], false);
});

function node(
  issueId: string,
  parentIssueId: string | null,
  siblingOrder: number,
  kind: "work" | "human",
  state: WorkflowNode["state"],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    issueId,
    identifier: issueId.toUpperCase(),
    parentIssueId,
    siblingOrder,
    kind,
    state,
    title: issueId,
    description: "",
    updatedAt: "2026-07-16T00:00:00Z",
    ...extra,
  };
}
