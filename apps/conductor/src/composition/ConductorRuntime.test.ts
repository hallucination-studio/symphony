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
  const reconstructed: string[] = [];
  let signalStarted: (() => void) | undefined;
  let releaseExecution: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseExecution = resolve; });
  const runtime = new ConductorRuntime(
    "conductor-1",
    gateway(roots, (root) => {
      reconstructed.push(root.issueId);
      return unclaimedView(root);
    }),
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
  assert.deepEqual(reconstructed, ["root-urgent"]);
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

test("Root scheduling conflict reports every dependency-cycle member", async () => {
  const first = discoveredRoot("root-cycle-a", "urgent", 1, "In Progress");
  const second = discoveredRoot("root-cycle-b", "high", 1, "In Progress");
  first.blockers = [{
    sourceIssueId: first.issueId,
    targetIssueId: second.issueId,
    targetState: "Done",
  }];
  second.blockers = [{
    sourceIssueId: second.issueId,
    targetIssueId: first.issueId,
    targetState: "Done",
  }];
  const reports: Array<{
    status: string;
    sanitizedReason?: string;
    rootId?: string;
  }> = [];
  let executions = 0;
  const runtime = new ConductorRuntime(
    "conductor-1",
    gateway([first, second], (root) => activeView(root, "working")),
    new LinearPriorityRootSchedulingPolicyImpl(),
    { async execute() { executions += 1; } },
    { async report(value) { reports.push(value); } },
  );

  await runtime.cycle();

  assert.equal(executions, 0);
  assert.deepEqual(reports, [
    {
      status: "blocked",
      sanitizedReason: "root_dependency_cycle",
      rootId: "root-cycle-a",
    },
    {
      status: "blocked",
      sanitizedReason: "root_dependency_cycle",
      rootId: "root-cycle-b",
    },
  ]);
});

test("Root scheduling conflict associates multiple active Work with its Root", async () => {
  const root = discoveredRoot("root-conflict", "urgent", 1, "In Progress");
  const reports: Array<{
    status: string;
    sanitizedReason?: string;
    rootId?: string;
  }> = [];
  const runtime = new ConductorRuntime(
    "conductor-1",
    gateway([root], (candidate) => ({
      ...activeView(candidate, "working"),
      workflowNodes: [0, 1].map((order) => ({
        issueId: `${candidate.issueId}-work-${order}`,
        identifier: `SYM-W${order}`,
        parentIssueId: null,
        siblingOrder: order,
        kind: "work" as const,
        state: "In Progress" as const,
        title: `Work ${order}`,
        description: "",
        updatedAt: candidate.updatedAt,
      })),
    })),
    new LinearPriorityRootSchedulingPolicyImpl(),
    { async execute() { throw new Error("must_not_execute"); } },
    { async report(value) { reports.push(value); } },
  );

  await runtime.cycle();

  assert.deepEqual(reports, [{
    status: "blocked",
    sanitizedReason: "multiple_active_leaves",
    rootId: "root-conflict",
  }]);
});

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
