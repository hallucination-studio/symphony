import assert from "node:assert/strict";
import test from "node:test";

import { RootIterationGuard } from "../internal/RootIterationGuard.js";

test("Root iteration guard rejects same-Root reentry without blocking another Root", () => {
  const guard = new RootIterationGuard();
  const releaseRootOne = guard.tryAcquire("root-1");

  assert.ok(releaseRootOne);
  assert.equal(guard.tryAcquire("root-1"), undefined);
  assert.ok(guard.tryAcquire("root-2"));

  releaseRootOne();
  releaseRootOne();
  assert.ok(guard.tryAcquire("root-1"));
});
