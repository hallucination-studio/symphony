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

test("run budget refuses a reservation that would consume the protected window", () => {
  const budget = new LinearRunBudgetImpl({ maxRequests: 400 });
  budget.observe({
    requestWindow: { limit: 1000, remaining: 300, reset: 3600 },
    complexityWindow: { limit: 2_000_000, remaining: 2_000_000, reset: 3600 },
  });

  assert.throws(
    () => budget.reserve({ requests: 51, complexity: 1 }),
    /linear_run_budget_exhausted/u,
  );
  const reservation = budget.reserve({ requests: 49, complexity: 1 });
  reservation.release();
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
