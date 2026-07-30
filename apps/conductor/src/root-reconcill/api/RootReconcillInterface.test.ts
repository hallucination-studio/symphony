import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "../../contracts/identity.js";
import type { RootReconcillFactoryInterface, RootReconcillInterface } from "./RootReconcillInterface.js";

test("Root Reconcill public boundary binds identity without exposing private resources", async () => {
  const rootId = parseRootIssueId("LIN-1");
  const generation = parseRuntimeGeneration(1);
  const root: RootReconcillInterface = {
    rootId,
    runtimeGeneration: generation,
    run: async (input) => ({
      schema_version: 1,
      root_id: rootId,
      runtime_generation: generation,
      correlation_id: input.correlation_id,
      outcome: "quiescent",
    }),
    close: () => Promise.resolve(),
  };
  const factory: RootReconcillFactoryInterface = {
    create: () => Promise.resolve(root),
  };

  const created = await factory.create({
    root_id: rootId,
    runtime_generation: generation,
    root_home: "/tmp/root-LIN-1",
  });
  assert.equal(created.rootId, rootId);
  assert.equal(created.runtimeGeneration, generation);
  assert.deepEqual(Object.keys(created).sort(), ["close", "rootId", "run", "runtimeGeneration"]);
});
