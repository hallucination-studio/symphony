import assert from "node:assert/strict";
import test from "node:test";

import { TurnCommandBudget } from "../internal/TurnCommandBudget.js";

test("command limit counts every request and mutation attempt without partial checkpoints", () => {
  const budget = new TurnCommandBudget({ maxBrokerCalls: 2, maxMutations: 1 });
  assert.equal(budget.consumeCall(), true);
  assert.equal(budget.consumeMutation(), true);
  assert.equal(budget.consumeCall(), true);
  assert.equal(budget.consumeMutation(), false);
  assert.equal(budget.consumeCall(), false);
  assert.deepEqual(budget.usage(), { broker_calls: 2, mutations: 1 });
});
