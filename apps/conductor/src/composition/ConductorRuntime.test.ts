import assert from "node:assert/strict";
import test from "node:test";

import { V3ConductorRuntime } from "./ConductorRuntime.js";
import { LinearPriorityRootSchedulingPolicyImpl } from "../root-scheduling/internal/LinearPriorityRootSchedulingPolicyImpl.js";
import { discoverCurrentRoots } from "../root-discovery/MultiRootDiscoveryPolicy.js";
import type { DiscoveredRoot, V3RootRunView } from "../root-workflow/api/Models.js";
import { conductorCycleDelayMs } from "./ConductorCycleDelayPolicy.js";

test("cycle delay policy is bounded, jittered, and immediate after progress", () => {
  assert.equal(conductorCycleDelayMs({ disposition: "progress", baseDelayMs: 1000, random: () => 1 }), 0);
  assert.equal(conductorCycleDelayMs({ disposition: "waiting-human", baseDelayMs: 1000, random: () => 0 }), 15_000);
  assert.equal(conductorCycleDelayMs({ disposition: "waiting-human", baseDelayMs: 1000, random: () => 1 }), 18_000);
  assert.equal(conductorCycleDelayMs({ disposition: "empty", baseDelayMs: 1000, random: () => 0 }), 60_000);
  assert.equal(conductorCycleDelayMs({ disposition: "needs-attention", baseDelayMs: 1000, random: () => 1 }), 72_000);
});

test("V3 scheduling skips waiting Roots and starts exactly one runnable Root", async () => {
  const roots = [root("waiting", "urgent", 1), root("run", "high", 2), root("later", "low", 3)];
  const assessed: string[] = [];
  const started: string[] = [];
  const runtime = new V3ConductorRuntime("conductor-1", gateway(roots, (id) =>
    view(id, id === "waiting", true)), new LinearPriorityRootSchedulingPolicyImpl(), {
      assessRoot(value) { assessed.push(value.root.issueId); return { rootIssueId: value.root.issueId,
        readiness: value.workflowNodes.length ? "waiting_human" : "runnable" }; },
      async claimRoot() { throw new Error("claim_not_expected"); },
      async runRootTurn(id) { started.push(id); return { kind: "completed", result: null }; },
    }, { async report() {} });

  await runtime.cycle();
  assert.deepEqual(assessed, ["waiting", "run"]);
  assert.deepEqual(started, ["run"]);
});

test("V3 cycles expose adaptive delay dispositions without changing Root selection", async () => {
  const policy = new LinearPriorityRootSchedulingPolicyImpl();
  const reporter = { async report() {} };
  const waitingRuntime = new V3ConductorRuntime(
    "conductor-1", gateway([root("waiting", "high", 1)], () => view("waiting", true, true)),
    policy, { ...runnableHarness([]), assessRoot(value) { return {
      rootIssueId: value.root.issueId, readiness: "waiting_human" as const,
    }; } }, reporter,
  );
  const emptyRuntime = new V3ConductorRuntime(
    "conductor-1", gateway([], () => view("unused", false, true)),
    policy, runnableHarness([]), reporter,
  );
  const started: string[] = [];
  const progressRuntime = new V3ConductorRuntime(
    "conductor-1", gateway([root("run", "high", 1)], () => view("run", false, true)),
    policy, runnableHarness(started), reporter,
  );

  assert.equal(await waitingRuntime.cycle(), "waiting-human");
  assert.equal(await emptyRuntime.cycle(), "empty");
  assert.equal(await progressRuntime.cycle(), "progress");
  assert.deepEqual(started, ["run"]);
});

test("V3 scheduling persists an unclaimed Conversation before its first Root Turn", async () => {
  const order: string[] = [];
  const candidate = view("new", false, false);
  const runtime = new V3ConductorRuntime("conductor-1", gateway([root("new", "high", 1)],
    () => candidate), new LinearPriorityRootSchedulingPolicyImpl(), {
      assessRoot() { return { rootIssueId: "new", readiness: "runnable" }; },
      async claimRoot() { order.push("claim"); candidate.managedComment = managed();
        return { kind: "ready", permit: { rootIssueId: "new", performerProfileId: "profile-1",
          performerId: "conversation-1", workspace: { branch: "symphony/runs/new",
            worktreePath: "/work/new", rootIssueId: "new" } } }; },
      async runRootTurn() { order.push("turn"); return { kind: "completed", result: null }; },
    }, { async report() {} });
  await runtime.cycle();
  assert.deepEqual(order, ["claim", "turn"]);
});

test("V3 scheduling stops Root pages at a strict proven boundary", async () => {
  let pages = 0;
  const started: string[] = [];
  const runtime = new V3ConductorRuntime("conductor-1", pagedGateway([
    { roots: [root("best", "urgent", 1), root("boundary", "low", 9)],
      hasNextPage: true, ordering: "scheduling" },
    { roots: [root("unseen", "low", 10)], hasNextPage: false, ordering: "scheduling" },
  ], () => { pages += 1; }), new LinearPriorityRootSchedulingPolicyImpl(), runnableHarness(started),
  { async report() {} });

  await runtime.cycle();

  assert.equal(pages, 1);
  assert.deepEqual(started, ["best"]);
});

test("V3 scheduling reads boundary ties and unsupported ordering to exhaustion", async () => {
  for (const ordering of ["scheduling", "unsupported"] as const) {
    let pages = 0;
    const started: string[] = [];
    const first = ordering === "scheduling"
      ? [root("z-candidate", "high", 1), root("z-boundary", "high", 1)]
      : [root("best", "urgent", 1)];
    const second = ordering === "scheduling"
      ? [root("a-winner", "high", 1)]
      : [root("later", "low", 9)];
    const runtime = new V3ConductorRuntime("conductor-1", pagedGateway([
      { roots: first, hasNextPage: true, ordering },
      { roots: second, hasNextPage: false, ordering },
    ], () => { pages += 1; }), new LinearPriorityRootSchedulingPolicyImpl(),
    runnableHarness(started), { async report() {} });

    await runtime.cycle();

    assert.equal(pages, 2);
    assert.deepEqual(started, [ordering === "scheduling" ? "a-winner" : "best"]);
  }
});

test("progressive Root paging selects the same Root as full discovery across scheduling facts", async () => {
  const cases: DiscoveredRoot[][] = [
    [root("urgent", "urgent", 9), root("high", "high", 1), root("low", "low", 1)],
    [root("order-1", "high", 1), root("order-2", "high", 2), root("low", "low", 0)],
    [root("a-id", "high", 1), root("z-id", "high", 1), root("low", "low", 2)],
    [
      { ...root("foreign", "urgent", 1), managedConductorId: "other" },
      root("owned", "high", 2),
      root("low", "low", 3),
    ],
    [
      { ...root("terminal", "urgent", 1), state: "Done" },
      root("active", "normal", 2),
      root("low", "low", 3),
    ],
    [
      { ...root("blocked", "urgent", 1), blockers: [{ sourceIssueId: "blocked",
        targetIssueId: "external", targetState: "Todo" }] },
      root("runnable", "normal", 2),
      root("low", "low", 3),
    ],
  ];
  const policy = new LinearPriorityRootSchedulingPolicyImpl();
  for (const roots of cases) {
    const expected = policy.evaluate(discoverCurrentRoots({
      projectId: "project-1",
      roots,
      conductorId: "conductor-1",
    })).orderedEligible[0]?.issueId;
    const started: string[] = [];
    const runtime = new V3ConductorRuntime("conductor-1", pagedGateway([
      { roots: roots.slice(0, 2), hasNextPage: true, ordering: "scheduling" },
      { roots: roots.slice(2), hasNextPage: false, ordering: "scheduling" },
    ], () => {}), policy, runnableHarness(started), { async report() {} });

    await runtime.cycle();

    assert.equal(started[0], expected);
  }
});

function gateway(roots: DiscoveredRoot[], reconstructV3: (id: string) => V3RootRunView) {
  return { async resolveProject() { return { kind: "resolved" as const, projectId: "project-1" }; },
    async listRoots() { return roots; }, async reconstructV3(id: string) { return reconstructV3(id); } };
}

function pagedGateway(
  pages: Array<{ roots: DiscoveredRoot[]; hasNextPage: boolean;
    ordering: "scheduling" | "unsupported" }>,
  observe: () => void,
) {
  return {
    async resolveProject() { return { kind: "resolved" as const, projectId: "project-1" }; },
    async listRoots() { return pages.flatMap(({ roots }) => roots); },
    async *listRootPages() {
      for (const page of pages) {
        observe();
        yield page;
      }
    },
    async reconstructV3(id: string) { return view(id, false, true); },
  };
}

function runnableHarness(started: string[]) {
  return {
    assessRoot(value: V3RootRunView) {
      return { rootIssueId: value.root.issueId, readiness: "runnable" as const };
    },
    async claimRoot() { throw new Error("claim_not_expected"); },
    async runRootTurn(id: string) {
      started.push(id);
      return { kind: "completed" as const, result: null };
    },
  };
}

function root(issueId: string, priority: DiscoveredRoot["priority"], order: number): DiscoveredRoot {
  return { issueId, identifier: issueId.toUpperCase(), state: "In Progress", title: issueId,
    description: "", updatedAt: "2026-07-19T00:00:00Z", projectId: "project-1",
    parentIssueId: null, isDelegatedToSymphony: true, managedConductorId: "conductor-1",
    priority, order, blockers: [] };
}

function managed() { return { conductorId: "conductor-1", performerProfileId: "profile-1",
  performerId: "conversation-1", deliveryBranch: "symphony/runs/root" }; }

function view(issueId: string, waiting: boolean, claimed: boolean): V3RootRunView {
  return { root: { issueId, identifier: issueId.toUpperCase(), state: claimed ? "In Progress" : "Todo",
    title: issueId, description: "", updatedAt: "2026-07-19T00:00:00Z" },
    conductorId: "conductor-1", resolvedProjectId: "project-1",
    ...(claimed ? { managedComment: managed() } : {}),
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: waiting ? [{ issueId: `${issueId}-human`, identifier: "HUMAN",
      parentIssueId: issueId, siblingOrder: 0, kind: "human", state: "In Progress",
      title: "Input", description: "", updatedAt: "2026-07-19T00:00:00Z" }] : [],
    workflowTreeComplete: true, blockerRelations: [], attentionProblems: [] };
}
