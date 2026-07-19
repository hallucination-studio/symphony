import assert from "node:assert/strict";
import test from "node:test";

import { ConductorRuntime } from "./ConductorRuntime.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "../root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import { hashRootInput } from "../root-workflow/api/index.js";
import type {
  DiscoveredRoot,
  RootRunView,
} from "../root-workflow/api/Models.js";

test("multi-Root runtime starts exactly one highest-ranked runnable action", async () => {
  const roots = [
    discoveredRoot("root-low", "low", 1, "Todo"),
    discoveredRoot("root-urgent", "urgent", 2, "Todo"),
  ];
  const starts: string[] = [];
  let signalStarted: (() => void) | undefined;
  let releaseExecution: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseExecution = resolve; });
  const runtime = new ConductorRuntime(
    "conductor-1",
    gateway(roots, (root) => unclaimedView(root)),
    new LinearPriorityRootSchedulingPolicyImpl(),
    {
      async execute(view) {
        starts.push(view.root.issueId);
        signalStarted?.();
        await released;
      },
    },
    { async report() {} },
  );

  const cycle = runtime.cycle();
  await started;
  assert.deepEqual(starts, ["root-urgent"]);
  releaseExecution?.();
  await cycle;
  assert.deepEqual(starts, ["root-urgent"]);
});

test("multi-Root runtime lets waiting Human yield to runnable Work", async () => {
  const waiting = discoveredRoot("root-waiting", "urgent", 1, "In Progress");
  const working = discoveredRoot("root-working", "low", 1, "In Progress");
  const executions: Array<{ rootId: string; action: string }> = [];
  const runtime = new ConductorRuntime(
    "conductor-1",
    gateway([waiting, working], (root) =>
      root.issueId === waiting.issueId
        ? activeView(root, "waiting")
        : activeView(root, "working")),
    new LinearPriorityRootSchedulingPolicyImpl(),
    {
      async execute(view, action) {
        executions.push({ rootId: view.root.issueId, action: action.kind });
      },
    },
    { async report() {} },
  );

  await runtime.cycle();

  assert.deepEqual(executions, [{
    rootId: "root-working",
    action: "execute_work",
  }]);
});

test("Turn-boundary refresh applies changed Priority, order, blockers, and Tree next cycle", async () => {
  const first = discoveredRoot("root-first", "urgent", 2, "In Progress");
  const second = discoveredRoot("root-second", "low", 2, "In Progress");
  let secondIsWaiting = true;
  let reads = 0;
  let releaseFirst: (() => void) | undefined;
  let signalFirst: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const executions: string[] = [];
  const runtime = new ConductorRuntime(
    "conductor-1",
    {
      async resolveProject() {
        return { kind: "resolved" as const, projectId: "project-1" };
      },
      async listRoots() {
        reads += 1;
        return [first, second];
      },
      async reconstruct(rootId: string) {
        if (rootId === first.issueId) return activeView(first, "working");
        return activeView(second, secondIsWaiting ? "waiting" : "working");
      },
    },
    new LinearPriorityRootSchedulingPolicyImpl(),
    {
      async execute(view) {
        executions.push(view.root.issueId);
        if (executions.length === 1) {
          signalFirst?.();
          await firstReleased;
        }
      },
    },
    { async report() {} },
  );

  const firstCycle = runtime.cycle();
  await firstStarted;
  first.priority = "low";
  first.order = 2;
  first.blockers = [{
    sourceIssueId: first.issueId,
    targetIssueId: "external-blocker",
    targetState: "In Progress",
  }];
  second.priority = "low";
  second.order = 1;
  secondIsWaiting = false;
  assert.deepEqual(executions, ["root-first"]);
  assert.equal(reads, 1);
  releaseFirst?.();
  await firstCycle;

  await runtime.cycle();

  assert.deepEqual(executions, ["root-first", "root-second"]);
  assert.equal(reads, 2);
});

for (const phase of ["gating", "delivering"] as const) {
  test(`Turn-boundary refresh blocks stale ${phase} action on the next cycle`, async () => {
    const root = discoveredRoot(`root-${phase}`, "urgent", 1, "In Progress");
    const actions: string[] = [];
    const runtime = new ConductorRuntime(
      "conductor-1",
      gateway([root], (candidate) => terminalPhaseView(candidate, phase)),
      new LinearPriorityRootSchedulingPolicyImpl(),
      {
        async execute(_view, action) {
          actions.push(action.kind);
        },
      },
      { async report() {} },
    );

    await runtime.cycle();
    root.blockers = [{
      sourceIssueId: root.issueId,
      targetIssueId: "external-blocker",
      targetState: "Todo",
    }];
    await runtime.cycle();

    assert.deepEqual(actions, [
      phase === "gating" ? "run_root_gate" : "deliver_root",
    ]);
  });
}

function gateway(
  roots: DiscoveredRoot[],
  reconstruct: (root: DiscoveredRoot) => RootRunView,
) {
  return {
    async resolveProject() {
      return { kind: "resolved" as const, projectId: "project-1" };
    },
    async listRoots() {
      return roots;
    },
    async reconstruct(rootId: string) {
      const root = roots.find(({ issueId }) => issueId === rootId);
      if (!root) throw new Error("root_missing");
      return reconstruct(root);
    },
  };
}

function discoveredRoot(
  issueId: string,
  priority: DiscoveredRoot["priority"],
  order: number,
  state: DiscoveredRoot["state"],
): DiscoveredRoot {
  return {
    issueId,
    identifier: issueId.toUpperCase(),
    state,
    title: issueId,
    description: "",
    updatedAt: "2026-07-19T00:00:00Z",
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
    priority,
    order,
    blockers: [],
  };
}

function unclaimedView(root: DiscoveredRoot): RootRunView {
  return {
    root,
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    phaseLabels: [],
    workflowNodes: [],
  };
}

function activeView(
  root: DiscoveredRoot,
  state: "waiting" | "working",
): RootRunView {
  return {
    root,
    conductorId: "conductor-1",
    resolvedProjectId: "project-1",
    phaseLabels: [state === "waiting" ? "awaiting-human" : "working"],
    managedComment: {
      conductorId: "conductor-1",
      performerProfileId: "profile-1",
      plannedRootInputHash: hashRootInput(root),
      deliveryBranch: `symphony/${root.issueId}`,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
    },
    profile: {
      profileId: "profile-1",
      readiness: "ready",
    },
    workflowNodes: state === "waiting"
      ? [{
          issueId: `${root.issueId}-approval`,
          identifier: "SYM-H",
          parentIssueId: null,
          siblingOrder: 0,
          kind: "human",
          humanKind: "plan_approval",
          state: "Todo",
          title: "Approve",
          description: "",
          updatedAt: root.updatedAt,
        }]
      : [{
          issueId: `${root.issueId}-work`,
          identifier: "SYM-W",
          parentIssueId: null,
          siblingOrder: 0,
          kind: "work",
          state: "Todo",
          title: "Work",
          description: "",
          updatedAt: root.updatedAt,
        }],
  };
}

function terminalPhaseView(
  root: DiscoveredRoot,
  phase: "gating" | "delivering",
): RootRunView {
  const view = activeView(root, "working");
  return {
    ...view,
    phaseLabels: [phase],
    workflowNodes: [],
  };
}
