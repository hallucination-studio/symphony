import assert from "node:assert/strict";
import test from "node:test";

import { parseRootIssueId, parseRuntimeGeneration } from "../../contracts/identity.js";
import type { RootBootstrap, RootObservationDiff } from "../../contracts/observation.js";
import type { RootOutput } from "../../contracts/root-interaction.js";
import type {
  RootReconcillFactoryInput,
  RootReconcillFactoryInterface,
  RootReconcillInterface,
} from "./RootReconcillInterface.js";

class BoundRoot implements RootReconcillInterface {
  constructor(
    readonly rootId: ReturnType<typeof parseRootIssueId>,
    readonly runtimeGeneration: ReturnType<typeof parseRuntimeGeneration>,
  ) {}

  bootstrap(input: RootBootstrap): Promise<RootOutput> {
    return Promise.resolve({
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      correlation_id: input.correlation_id,
      kind: "decision",
      decision: "Wait",
      reason: "inert fixture",
    });
  }

  advance(input: RootObservationDiff): Promise<RootOutput> {
    return this.bootstrap(input as unknown as RootBootstrap);
  }

  close(): Promise<void> { return Promise.resolve(); }
}

const factory = {
  create(input: RootReconcillFactoryInput) {
    return Promise.resolve(new BoundRoot(input.root_id, input.runtime_generation));
  },
} satisfies RootReconcillFactoryInterface;

test("Root factory binds immutable Root identity and generation", async () => {
  const root = await factory.create({
    root_id: parseRootIssueId("LIN-1"),
    runtime_generation: parseRuntimeGeneration(1),
    root_home: "/tmp/root-LIN-1",
  });
  assert.equal(root.rootId, "LIN-1");
  assert.equal(root.runtimeGeneration, 1);
  assert.deepEqual(Object.keys(root).sort(), ["rootId", "runtimeGeneration"]);
});
