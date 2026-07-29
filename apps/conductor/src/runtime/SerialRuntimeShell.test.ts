import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId } from "../contracts/identity.js";
import type { RuntimeEvent } from "../runtime-logs/StructuredLogger.js";
import { SerialRuntimeShell, type RuntimeDependencies } from "./SerialRuntimeShell.js";

function dependencies(roots: Awaited<ReturnType<RuntimeDependencies["linear"]["discoverRoots"]>>) {
  const events: RuntimeEvent[] = [];
  const calls: string[] = [];
  const value: RuntimeDependencies = {
    linear: {
      discoverRoots: () => Promise.resolve(roots),
      readRoot: () => Promise.reject(new Error("unexpected_read")),
      mutate: () => Promise.reject(new Error("unexpected_mutation")),
    },
    rootReconcillFactory: { create: () => { calls.push("root"); return Promise.reject(new Error("unexpected_root")); } },
    performer: {
      executePlan: () => { calls.push("plan"); return Promise.reject(new Error("unexpected_plan")); },
      executeWork: () => { calls.push("work"); return Promise.reject(new Error("unexpected_work")); },
      executeVerify: () => { calls.push("verify"); return Promise.reject(new Error("unexpected_verify")); },
      closeCycle: () => Promise.resolve(),
    },
    git: {
      prepare: () => { calls.push("git"); return Promise.reject(new Error("unexpected_git")); },
      read: () => Promise.reject(new Error("unexpected_git")),
      commit: () => Promise.reject(new Error("unexpected_git")),
    },
    delivery: {
      read: () => Promise.reject(new Error("unexpected_delivery")),
      push: () => { calls.push("delivery"); return Promise.reject(new Error("unexpected_delivery")); },
      createPullRequest: () => Promise.reject(new Error("unexpected_delivery")),
    },
    logger: { publish: (event) => events.push(event) },
  };
  return { value, events, calls };
}

test("inert shell returns to idle when discovery has no Roots", async () => {
  const fixture = dependencies([]);
  const shell = new SerialRuntimeShell(fixture.value);
  await shell.tick();
  assert.equal(shell.state, "idle");
  assert.deepEqual(fixture.calls, []);
  assert.deepEqual(fixture.events.map(({ event }) => event), ["discovery_started", "discovery_completed"]);
});

test("inert shell fails closed before any unimplemented Root effect", async () => {
  const fixture = dependencies([{
    root_id: parseRootIssueId("LIN-1"), status: "Todo", priority: 1, created_at: "2026-07-29T00:00:00Z",
  }]);
  const shell = new SerialRuntimeShell(fixture.value);
  await assert.rejects(shell.tick(), /root_execution_not_implemented/u);
  assert.equal(shell.state, "stopped");
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.events.at(-1)?.event, "root_execution_stopped");
});
