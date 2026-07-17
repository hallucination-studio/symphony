import assert from "node:assert/strict";
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
    now: () => (nowCalls++ === 0 ? 0 : 10),
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
