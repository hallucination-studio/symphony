import assert from "node:assert/strict";
import test from "node:test";

import {
  createTargetWorkflowRequestSignal,
  remainingTargetWorkflowTimeout,
  withTargetWorkflowDeadline,
} from "../../tools/e2e/target-workflow-deadline.mjs";

test("target workflow absolute deadlines are capped at five minutes", () => {
  assert.equal(remainingTargetWorkflowTimeout(1_000_000, () => 0), 300_000);
});

test("target workflow request signals retain the parent and enforce a request timeout", async () => {
  const parent = new AbortController();
  const requestSignal = createTargetWorkflowRequestSignal(parent.signal, 10);
  assert.notEqual(requestSignal, parent.signal);
  await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => reject(new Error("request_timeout_signal_test_failed")), 100);
    requestSignal.addEventListener("abort", () => {
      clearTimeout(watchdog);
      resolve();
    }, { once: true });
  });
  assert.equal(requestSignal.aborted, true);
  parent.abort();
});

test("target workflow deadline invokes timeout cleanup before rejecting", async () => {
  let cleanupError;
  await assert.rejects(
    withTargetWorkflowDeadline(
      () => new Promise(() => {}),
      Date.now() + 10,
      { onTimeout: (error) => { cleanupError = error; } },
    ),
    /target_live_timeout/u,
  );
  assert.equal(cleanupError?.message, "target_live_timeout");
});

test("target workflow deadline rejects an invalid timeout callback", async () => {
  await assert.rejects(
    withTargetWorkflowDeadline(() => Promise.resolve(), Date.now() + 100, { onTimeout: true }),
    /target_live_deadline_callback_invalid/u,
  );
});
