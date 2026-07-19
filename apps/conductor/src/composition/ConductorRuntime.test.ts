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
