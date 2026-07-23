import assert from "node:assert/strict";
import test from "node:test";

import { LinearRequestObserverImpl } from "../dist/internal/linear-gateway/internal/LinearRequestObserverImpl.js";

test("request observer records low upstream remaining values without blocking", () => {
  const observer = new LinearRequestObserverImpl();
  observer.observe({
    requestWindow: { limit: 1000, remaining: 1, reset: 60 },
    complexityWindow: { limit: 2_000_000, remaining: 1, reset: 60 },
  });
  observer.recordLogicalOperation();
  observer.observe({ status: 200 });
  assert.deepEqual(observer.snapshot(), {
    logicalOperations: 1,
    physicalRequests: 2,
    complexityConsumed: 0,
    requestWindow: { limit: 1000, remaining: 1, reset: 60 },
    complexityWindow: { limit: 2_000_000, remaining: 1, reset: 60 },
    rateLimited: false,
  });
});

test("each observer starts with isolated counters", () => {
  const first = new LinearRequestObserverImpl();
  first.recordLogicalOperation();
  first.observe({ status: 200 });
  const second = new LinearRequestObserverImpl();
  assert.deepEqual(second.snapshot(), {
    logicalOperations: 0,
    physicalRequests: 0,
    complexityConsumed: 0,
    rateLimited: false,
  });
});

test("429 is retained as evidence but does not create a local reset lock", () => {
  const observer = new LinearRequestObserverImpl();
  observer.observe({ status: 429, requestWindow: { remaining: 0, reset: 3600 } });
  observer.observe({ status: 200 });
  assert.equal(observer.snapshot().rateLimited, true);
  assert.equal(observer.snapshot().physicalRequests, 2);
});

test("429 notifies listeners once and immediately notifies listeners registered later", () => {
  const observer = new LinearRequestObserverImpl();
  let notifications = 0;
  observer.onRateLimited(() => { notifications += 1; });
  observer.observe({ status: 429 });
  observer.observe({ status: 429 });
  assert.equal(notifications, 1);

  observer.onRateLimited(() => { notifications += 1; });
  assert.equal(notifications, 2);
});

test("observer measures net complexity consumption across noisy headers", () => {
  const observer = new LinearRequestObserverImpl();
  observer.observe({ complexityWindow: { limit: 2_000_000, remaining: 240_000, reset: 3600 } });
  observer.observe({ complexityWindow: { limit: 2_000_000, remaining: 240_500, reset: 3599 } });
  observer.observe({ complexityWindow: { limit: 2_000_000, remaining: 239_900, reset: 3598 } });
  assert.equal(observer.snapshot().complexityConsumed, 100);
});
