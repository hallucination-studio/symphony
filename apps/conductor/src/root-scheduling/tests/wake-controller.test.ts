import assert from "node:assert/strict";
import test from "node:test";

import { RootWakeController } from "../internal/RootWakeController.js";

test("Root wake controller starts immediately, coalesces duplicate wakes, and favors a nearer deadline", () => {
  const controller = new RootWakeController({
    now: () => 1_000,
    random: () => 0.5,
  });

  assert.equal(controller.nextDelay({ disposition: "empty" }), 0);
  assert.equal(controller.nextDelay({ disposition: "empty" }), 30_000);

  controller.wake();
  controller.wake();
  assert.equal(controller.nextDelay({ disposition: "empty" }), 0);
  assert.equal(controller.nextDelay({ disposition: "empty" }), 30_000);

  assert.equal(controller.nextDelay({
    disposition: "waiting-human",
    deadlineAtMs: 5_000,
  }), 4_000);
});

test("Root wake controller bounds transient discovery backoff and resets it after a complete read", () => {
  const controller = new RootWakeController({
    now: () => 0,
    random: () => 0.5,
  });

  controller.nextDelay({ disposition: "empty" });
  assert.equal(controller.nextDelay({ disposition: "discovery-degraded" }), 1_000);
  assert.equal(controller.nextDelay({ disposition: "discovery-degraded" }), 2_000);
  assert.equal(controller.nextDelay({ disposition: "empty" }), 30_000);
  assert.equal(controller.nextDelay({ disposition: "discovery-degraded" }), 1_000);
});

test("Root wake controller coalesces duplicate wakes that arrive while idle", async () => {
  const controller = new RootWakeController({ now: () => 0, random: () => 0.5 });
  controller.nextDelay({ disposition: "empty" });

  const waiting = controller.wait({ disposition: "empty", deadlineAtMs: 1 });
  controller.wake();
  controller.wake();
  await waiting;

  assert.equal(controller.nextDelay({ disposition: "empty" }), 30_000);
});
