import assert from "node:assert/strict";
import test from "node:test";

import { LinearRunBudgetImpl } from "../dist/internal/linear-gateway/internal/LinearRunBudgetImpl.js";

test("run budget reserves request and complexity capacity before a call", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.observe({
    requestWindow: { limit: 1000, remaining: 1000, reset: 3600 },
    complexityWindow: { limit: 2_000_000, remaining: 2_000_000, reset: 3600 },
  });

  const reservation = budget.reserve({ requests: 1, complexity: 10_000 });
  assert.deepEqual(budget.snapshot(), {
    logicalOperations: 0,
    physicalRequests: 1,
    reservedRequests: 1,
    reservedComplexity: 10_000,
    complexityConsumed: 0,
    requestWindow: { limit: 1000, remaining: 1000, reset: 3600 },
    complexityWindow: { limit: 2_000_000, remaining: 2_000_000, reset: 3600 },
    rateLimited: false,
  });
  reservation.release();
  assert.equal(budget.snapshot().reservedRequests, 0);
});

test("a fresh run budget does not inherit another run's protected reserve", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.observe({
    requestWindow: { limit: 1000, remaining: 251, reset: 3600 },
    complexityWindow: { limit: 2_000_000, remaining: 506_726, reset: 3600 },
  });

  const reservation = budget.reserve({ requests: 1, complexity: 10_000 });
  assert.equal(budget.snapshot().reservedRequests, 1);
  assert.equal(budget.snapshot().reservedComplexity, 10_000);
  reservation.release();
});

test("run budget refuses a request that exceeds the actual upstream remainder", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.observe({
    requestWindow: { limit: 1000, remaining: 1, reset: 3600 },
    complexityWindow: { limit: 2_000_000, remaining: 9_999, reset: 3600 },
  });

  assert.throws(() => budget.reservePhysicalRequest(), /linear_run_budget_exhausted/u);
});

test("run budget treats 429 as terminal for the observed rate window", () => {
  let now = 1_000;
  const budget = new LinearRunBudgetImpl({ maxRequests: 400, now: () => now });
  budget.observe({
    requestWindow: { limit: 1000, remaining: 900, reset: 60 },
    complexityWindow: { limit: 2_000_000, remaining: 1_900_000, reset: 60 },
    status: 429,
  });

  assert.equal(budget.snapshot().rateLimited, true);
  assert.throws(() => budget.reserve({ requests: 1, complexity: 1 }), /linear_run_rate_limited/u);
  now += 60_000;
  const reservation = budget.reserve({ requests: 1, complexity: 1 });
  reservation.release();
});

test("run budget treats an absolute millisecond reset as the rate-window deadline", () => {
  let now = 1_700_000_000_000;
  const budget = new LinearRunBudgetImpl({ maxRequests: 400, now: () => now });
  budget.observe({
    requestWindow: { limit: 5000, remaining: 1, reset: 1_700_000_060_000 },
    status: 429,
  });

  assert.equal(budget.snapshot().rateLimited, true);
  now = 1_700_000_059_999;
  assert.throws(() => budget.reserve({ requests: 1, complexity: 1 }), /linear_run_rate_limited/u);
  now = 1_700_000_060_000;
  const reservation = budget.reserve({ requests: 1, complexity: 1 });
  reservation.release();
});

test("run budget counts logical operations and physical observations separately", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.recordLogicalOperation();
  budget.recordLogicalOperation();
  budget.observe({
    requestWindow: { limit: 1000, remaining: 999, reset: 60 },
    complexityWindow: { limit: 2_000_000, remaining: 2_000_000, reset: 60 },
    status: 200,
  });
  budget.observe({
    requestWindow: { limit: 1000, remaining: 998, reset: 60 },
    complexityWindow: { limit: 2_000_000, remaining: 1_999_000, reset: 60 },
    status: 200,
  });
  assert.deepEqual(budget.snapshot(), {
    logicalOperations: 2,
    physicalRequests: 2,
    reservedRequests: 0,
    reservedComplexity: 0,
    complexityConsumed: 1000,
    requestWindow: { limit: 1000, remaining: 998, reset: 60 },
    complexityWindow: { limit: 2_000_000, remaining: 1_999_000, reset: 60 },
    rateLimited: false,
  });
});

test("permitPhysicalRequest releases its reservation on the matching observation", () => {
  const budget = new LinearRunBudgetImpl();
  budget.permitPhysicalRequest();
  assert.equal(budget.snapshot().reservedRequests, 1);
  budget.observe({ status: 200 });
  assert.deepEqual(
    {
      physicalRequests: budget.snapshot().physicalRequests,
      reservedRequests: budget.snapshot().reservedRequests,
    },
    { physicalRequests: 1, reservedRequests: 0 },
  );
});

test("run budget resets the complexity baseline when the upstream window rolls over", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.observe({ complexityWindow: { limit: 2_000_000, remaining: 1_999_000, reset: 1 } });
  budget.observe({ complexityWindow: { limit: 2_000_000, remaining: 2_000_000, reset: 3600 } });
  budget.observe({ complexityWindow: { limit: 2_000_000, remaining: 1_998_000, reset: 3599 } });

  assert.equal(budget.snapshot().complexityConsumed, 2_000);
});

test("run budget measures the maximum net complexity drop across noisy headers", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.observe({ complexityWindow: { limit: 2_000_000, remaining: 240_000, reset: 3600 } });
  budget.observe({ complexityWindow: { limit: 2_000_000, remaining: 240_500, reset: 3599 } });
  budget.observe({ complexityWindow: { limit: 2_000_000, remaining: 239_900, reset: 3598 } });
  budget.observe({ complexityWindow: { limit: 2_000_000, remaining: 240_300, reset: 3597 } });

  assert.equal(budget.snapshot().complexityConsumed, 100);
});

test("run budget does not subtract observed requests from upstream remaining twice", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.observe({
    requestWindow: { limit: 1000, remaining: 300, reset: 3600 },
  });

  const reservation = budget.reserve({ requests: 50, complexity: 0 });
  assert.equal(budget.snapshot().reservedRequests, 50);
  reservation.release();
});

test("run budget does not subtract observed complexity consumption from upstream remaining twice", () => {
  const budget = new LinearRunBudgetImpl();
  budget.observe({
    complexityWindow: { limit: 2_000_000, remaining: 700_000, reset: 3600 },
  });
  budget.observe({
    complexityWindow: { limit: 2_000_000, remaining: 670_000, reset: 3599 },
  });

  const reservation = budget.reserve({ requests: 1, complexity: 150_000 });
  assert.equal(budget.snapshot().reservedComplexity, 150_000);
  reservation.release();
});
