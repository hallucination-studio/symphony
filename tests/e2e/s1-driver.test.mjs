import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesktopClient } from "../../tools/e2e/desktop-client.mjs";
import { createS1ClaimDriver } from "../../tools/e2e/s1-driver.mjs";

test("S1 claim driver creates the fixed Root A through the Linear operator", async () => {
  const calls = [];
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot(input) {
        calls.push(input);
        return {
          rootId: "root-a",
          identifier: "HELL-1",
          projectId: "project-1",
          projectName: "HELL",
          state: "Todo",
          delegated: true,
          readBack: true,
        };
      },
      async readRootClaimFacts() {
        throw new Error("claim_read_not_expected");
      },
    },
    client: desktopObservationClient(),
    projectSlugId: "8ab43179fb54",
  });

  assert.deepEqual(await driver.createRootA(), {
    rootId: "root-a",
    identifier: "HELL-1",
    projectId: "project-1",
    projectName: "HELL",
    state: "Todo",
    delegated: true,
    readBack: true,
  });
  assert.deepEqual(calls, [{
    projectSlugId: "8ab43179fb54",
    title: "[E2E] Root A",
    description: "fixed fixture",
  }]);
});

test("S1 claim driver waits for Linear claim and combines safe Desktop observations", async () => {
  const facts = [
    {
      rootId: "root-a",
      state: "Todo",
      phase: undefined,
      singletonCount: 0,
      managedCommentCount: 0,
      managedCommentReady: false,
    },
    {
      rootId: "root-a",
      state: "In Progress",
      phase: "planning",
      singletonCount: 1,
      managedCommentCount: 1,
      managedCommentReady: true,
      deliveryBranch: "symphony/runs/hell-1",
    },
  ];
  const calls = [];
  let nowCalls = 0;
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts(input) {
        calls.push(["facts", input]);
        return facts.shift();
      },
    },
    client: desktopObservationClient({
      profile: { readiness: "ready", isActive: true },
      runtime: { status: "Ready" },
      calls,
    }),
    projectSlugId: "8ab43179fb54",
    now: () => [0, 10, 20][nowCalls++] ?? 20,
    sleep: async (delayMs) => calls.push(["sleep", delayMs]),
    pollIntervalMs: 5,
    timeoutMs: 100,
  });

  await driver.createRootA();
  assert.deepEqual(await driver.waitForClaim(), {
    rootId: "root-a",
    state: "In Progress",
    phase: "planning",
    singletonCount: 1,
    managedCommentCount: 1,
    managedCommentReady: true,
    deliveryBranch: "symphony/runs/hell-1",
    profileReadiness: "ready",
    profileIsActive: true,
    runtimeStatus: "Ready",
  });
  assert.equal(calls.some(([kind]) => kind === "open-conductors"), true);
  assert.equal(calls.some(([kind]) => kind === "sleep"), true);
});

test("S1 claim driver fails closed when the claim deadline expires", async () => {
  let nowCalls = 0;
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts() {
        return {
          rootId: "root-a",
          state: "Todo",
          phase: undefined,
          singletonCount: 0,
          managedCommentCount: 0,
          managedCommentReady: false,
        };
      },
    },
    client: desktopObservationClient(),
    projectSlugId: "8ab43179fb54",
    now: () => (nowCalls++ === 0 ? 0 : 10),
    sleep: async () => undefined,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  await driver.createRootA();
  await assert.rejects(driver.waitForClaim(), /s1_root_claim_timeout/u);
});

test("S1 claim driver rejects malformed external claim facts", async () => {
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "planning",
          singletonCount: 1,
          managedCommentCount: 1,
          managedCommentReady: true,
          deliveryBranch: "branch\nsecret",
          performer_id: "must-not-escape",
        };
      },
    },
    client: desktopObservationClient({
      profile: { readiness: "ready", isActive: true },
      runtime: { status: "Ready" },
    }),
    projectSlugId: "8ab43179fb54",
    timeoutMs: 10,
    pollIntervalMs: 1,
    sleep: async () => undefined,
  });

  await driver.createRootA();
  await assert.rejects(driver.waitForClaim(), /s1_claim_facts_invalid/u);
});

test("S1 claim driver waits for the Plan barrier without starting Work", async () => {
  const planFacts = [
    {
      rootId: "root-a",
      state: "In Progress",
      phase: "planning",
      treeMatches: false,
      planApprovalCount: 0,
      planApprovalReady: false,
      plannedRootInputReady: false,
      workStates: [],
      workStarted: false,
    },
    {
      rootId: "root-a",
      state: "In Progress",
      phase: "awaiting-human",
      treeMatches: true,
      planApprovalCount: 1,
      planApprovalState: "In Progress",
      planApprovalReady: true,
      plannedRootInputReady: true,
      workStates: ["Todo"],
      workStarted: false,
    },
  ];
  let nowCalls = 0;
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "planning",
          singletonCount: 1,
          managedCommentCount: 1,
          managedCommentReady: true,
        };
      },
      async readRootPlanFacts() {
        return planFacts.shift();
      },
    },
    client: desktopObservationClient({
      profile: { readiness: "ready", isActive: true },
      runtime: { status: "Ready" },
    }),
    projectSlugId: "8ab43179fb54",
    now: () => (nowCalls++ === 0 ? 0 : 10),
    sleep: async () => undefined,
    timeoutMs: 100,
    pollIntervalMs: 5,
  });

  await driver.createRootA();
  await driver.waitForClaim();
  assert.deepEqual(await driver.waitForPlan(), {
    rootId: "root-a",
    state: "In Progress",
    phase: "awaiting-human",
    treeMatches: true,
    planApprovalCount: 1,
    planApprovalState: "In Progress",
    planApprovalReady: true,
    plannedRootInputReady: true,
    workStates: ["Todo"],
    workStarted: false,
  });
});

test("S1 claim driver stops when Plan evidence shows Work already started", async () => {
  let nowCalls = 0;
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "planning",
          singletonCount: 1,
          managedCommentCount: 1,
          managedCommentReady: true,
        };
      },
      async readRootPlanFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "awaiting-human",
          treeMatches: true,
          planApprovalCount: 1,
          planApprovalState: "In Progress",
          planApprovalReady: true,
          plannedRootInputReady: true,
          workStates: ["In Progress"],
          workStarted: true,
        };
      },
    },
    client: desktopObservationClient({
      profile: { readiness: "ready", isActive: true },
      runtime: { status: "Ready" },
    }),
    projectSlugId: "8ab43179fb54",
    now: () => [0, 10, 20][nowCalls++] ?? 20,
    sleep: async () => undefined,
    timeoutMs: 5,
    pollIntervalMs: 1,
  });

  await driver.createRootA();
  await driver.waitForClaim();
  await assert.rejects(driver.waitForPlan(), /s1_plan_timeout/u);
});

test("S1 claim driver observes a stable Plan barrier before approval", async () => {
  const calls = [];
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "planning",
          singletonCount: 1,
          managedCommentCount: 1,
          managedCommentReady: true,
          deliveryBranch: "symphony/runs/hell-1",
        };
      },
      async readRootPlanFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "awaiting-human",
          treeMatches: true,
          planApprovalCount: 1,
          planApprovalState: "In Progress",
          planApprovalReady: true,
          plannedRootInputReady: true,
          workStates: ["Todo", "Canceled"],
          workStarted: false,
        };
      },
    },
    git: {
      async readCommitCount(input) {
        calls.push(input);
        return 0;
      },
    },
    client: desktopObservationClient({
      profile: { readiness: "ready", isActive: true },
      runtime: { status: "Ready" },
    }),
    projectSlugId: "8ab43179fb54",
    repositoryPath: "/tmp/e2e-repository",
    baseBranch: "main",
  });

  await driver.createRootA();
  await driver.waitForClaim();
  await driver.waitForPlan();
  assert.deepEqual(await driver.observePlanBarrier(), {
    rootId: "root-a",
    stable: true,
    phase: "awaiting-human",
    workStates: ["Todo", "Canceled"],
    workStarted: false,
    commitCount: 0,
  });
  assert.deepEqual(calls, [{
    repositoryPath: "/tmp/e2e-repository",
    baseBranch: "main",
    deliveryBranch: "symphony/runs/hell-1",
  }]);
});

test("S1 claim driver rejects a Plan barrier with a started Work or commit", async () => {
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "planning",
          singletonCount: 1,
          managedCommentCount: 1,
          managedCommentReady: true,
          deliveryBranch: "symphony/runs/hell-1",
        };
      },
      async readRootPlanFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "awaiting-human",
          treeMatches: true,
          planApprovalCount: 1,
          planApprovalState: "In Progress",
          planApprovalReady: true,
          plannedRootInputReady: true,
          workStates: ["In Progress"],
          workStarted: true,
        };
      },
    },
    git: { async readCommitCount() { return 1; } },
    client: desktopObservationClient({
      profile: { readiness: "ready", isActive: true },
      runtime: { status: "Ready" },
    }),
    projectSlugId: "8ab43179fb54",
    repositoryPath: "/tmp/e2e-repository",
    baseBranch: "main",
  });

  await driver.createRootA();
  await driver.waitForClaim();
  assert.deepEqual(await driver.observePlanBarrier(), {
    rootId: "root-a",
    stable: false,
    phase: "awaiting-human",
    workStates: ["In Progress"],
    workStarted: true,
    commitCount: 1,
  });
});

test("S1 claim driver reads the real delivery branch commit count", async () => {
  const repositoryPath = mkdtempSync(path.join(tmpdir(), "symphony-s1-git-"));
  try {
    runGit(repositoryPath, ["init", "--quiet", "--initial-branch", "main"]);
    runGit(repositoryPath, ["config", "user.email", "e2e@example.invalid"]);
    runGit(repositoryPath, ["config", "user.name", "Symphony E2E"]);
    writeFileSync(path.join(repositoryPath, "fixture.txt"), "base\n");
    runGit(repositoryPath, ["add", "fixture.txt"]);
    runGit(repositoryPath, ["commit", "--quiet", "-m", "base"]);
    runGit(repositoryPath, ["branch", "symphony/runs/hell-1"]);

    const driver = createS1ClaimDriver({
      linear: stableLinear({ deliveryBranch: "symphony/runs/hell-1" }),
      client: desktopObservationClient({
        profile: { readiness: "ready", isActive: true },
        runtime: { status: "Ready" },
      }),
      projectSlugId: "8ab43179fb54",
      repositoryPath,
      baseBranch: "main",
    });

    await driver.createRootA();
    await driver.waitForClaim();
    assert.equal((await driver.observePlanBarrier()).commitCount, 0);

    runGit(repositoryPath, ["switch", "symphony/runs/hell-1"]);
    writeFileSync(path.join(repositoryPath, "fixture.txt"), "work\n");
    runGit(repositoryPath, ["add", "fixture.txt"]);
    runGit(repositoryPath, ["commit", "--quiet", "-m", "work"]);
    const afterCommit = await driver.observePlanBarrier();
    assert.deepEqual({ stable: afterCommit.stable, commitCount: afterCommit.commitCount }, {
      stable: false,
      commitCount: 1,
    });
  } finally {
    rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("S1 claim driver approves the Plan only after working read-back", async () => {
  let approved = false;
  const driver = createS1ClaimDriver({
    linear: {
      async createAndDelegateRoot() {
        return { rootId: "root-a", delegated: true, readBack: true };
      },
      async readRootClaimFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: "planning",
          singletonCount: 1,
          managedCommentCount: 1,
          managedCommentReady: true,
          deliveryBranch: "symphony/runs/hell-1",
        };
      },
      async readRootPlanFacts() {
        return {
          rootId: "root-a",
          state: "In Progress",
          phase: approved ? "working" : "awaiting-human",
          treeMatches: true,
          planApprovalCount: 1,
          planApprovalState: approved ? "Done" : "In Progress",
          planApprovalReady: !approved,
          plannedRootInputReady: true,
          workStates: ["Todo"],
          workStarted: false,
        };
      },
      async approvePlan(input) {
        assert.deepEqual(input, {
          projectSlugId: "8ab43179fb54",
          rootId: "root-a",
        });
        approved = true;
        return { rootId: "root-a", approvalState: "Done", readBack: true };
      },
    },
    git: { async readCommitCount() { return 0; } },
    client: desktopObservationClient({
      profile: { readiness: "ready", isActive: true },
      runtime: { status: "Ready" },
    }),
    projectSlugId: "8ab43179fb54",
    repositoryPath: "/tmp/e2e-repository",
    baseBranch: "main",
    now: () => 0,
    sleep: async () => undefined,
    timeoutMs: 100,
    pollIntervalMs: 5,
  });

  await driver.createRootA();
  await driver.waitForClaim();
  await driver.waitForPlan();
  assert.deepEqual(await driver.approvePlan(), {
    rootId: "root-a",
    approvalState: "Done",
    phase: "working",
    workStarted: false,
    readBack: true,
  });
});

test("Desktop client reads the active Profile and Conductor runtime from the UI", async () => {
  const calls = [];
  const browser = {
    async $$(selector) {
      if (selector === ".nav-link") {
        return [
          link("Overview", calls),
          link("Conductors", calls),
        ];
      }
      if (selector === "[data-testid=profile-row]") {
        return [profileRow("E2E primary · Active for new Roots\nAccount · model · Ready")];
      }
      throw new Error(`unexpected_selector:${selector}`);
    },
    async $(selector) {
      if (selector === "[data-testid=conductor-runtime-status]") {
        return {
          async waitForDisplayed() {},
          async getText() { return "Ready"; },
        };
      }
      throw new Error(`unexpected_selector:${selector}`);
    },
    async waitUntil(predicate) {
      assert.equal(await predicate(), true);
    },
  };
  const client = createDesktopClient({ browser, ui: {}, timeoutMs: 10 });

  await client.openConductors();
  assert.deepEqual(await client.readProfile("E2E primary"), {
    readiness: "ready",
    isActive: true,
  });
  assert.deepEqual(await client.readConductorRuntime(), { status: "Ready" });
  assert.deepEqual(calls, [["click", "Conductors"]]);
});

function desktopObservationClient({
  profile = { readiness: "login-required", isActive: false },
  runtime = { status: "Starting" },
  calls = [],
} = {}) {
  return {
    async openConductors() {
      calls.push(["open-conductors"]);
    },
    async readProfile() {
      return profile;
    },
    async readConductorRuntime() {
      return runtime;
    },
  };
}

function stableLinear({ deliveryBranch }) {
  return {
    async createAndDelegateRoot() {
      return { rootId: "root-a", delegated: true, readBack: true };
    },
    async readRootClaimFacts() {
      return {
        rootId: "root-a",
        state: "In Progress",
        phase: "planning",
        singletonCount: 1,
        managedCommentCount: 1,
        managedCommentReady: true,
        deliveryBranch,
      };
    },
    async readRootPlanFacts() {
      return {
        rootId: "root-a",
        state: "In Progress",
        phase: "awaiting-human",
        treeMatches: true,
        planApprovalCount: 1,
        planApprovalState: "In Progress",
        planApprovalReady: true,
        plannedRootInputReady: true,
        workStates: ["Todo"],
        workStarted: false,
      };
    },
  };
}

function runGit(repositoryPath, arguments_) {
  return execFileSync("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function link(text, calls) {
  return {
    async getText() { return text; },
    async click() { calls.push(["click", text]); },
  };
}

function profileRow(text) {
  return {
    async getText() { return text; },
  };
}
