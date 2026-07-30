import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseRepositoryId,
  parseRootIssueId,
  parseRuntimeGeneration,
} from "../contracts/identity.js";
import type { RootToolCall } from "../contracts/root-interaction.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type {
  RootReconcillFactoryInput,
  RootReconcillFactoryInterface,
  RootReconcillInterface,
} from "../root-reconcill/api/RootReconcillInterface.js";
import { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import { CodexRootTurnTransportFactory, RootReconcillFactory } from "../root-reconcill/internal/RootReconcill.js";
import type { RootToolExecutor, RootToolsFactoryInterface } from "./RootRuntime.js";
import { RootRuntimeRegistry } from "./RootRuntimeRegistry.js";

function workspace(root: string): RootWorkspaceIdentity {
  return {
    root_id: parseRootIssueId(root),
    repository_id: parseRepositoryId(`repo:${root}`),
    base_branch: "main",
    head_branch: `symphony/${root}`,
  };
}

async function homes() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-registry-"));
  const programData = path.join(temporary, "program");
  const performerHome = path.join(temporary, "performer");
  await Promise.all([mkdir(programData), mkdir(performerHome)]);
  return { temporary, programData, performerHome, manager: await RootHomeManager.create(programData, performerHome) };
}

class FakeRootFactory implements RootReconcillFactoryInterface {
  readonly resources: Array<{
    root: RootReconcillInterface;
    process: object;
    thread: object;
    baseline: object;
    correlations: object;
    closed: boolean;
  }> = [];

  async create(input: RootReconcillFactoryInput): Promise<RootReconcillInterface> {
    const resource = {
      root: null as unknown as RootReconcillInterface,
      process: {}, thread: {}, baseline: {}, correlations: {}, closed: false,
    };
    resource.root = {
      rootId: input.root_id,
      runtimeGeneration: input.runtime_generation,
      bootstrap: () => Promise.reject(new Error("unexpected_bootstrap")),
      advance: () => Promise.reject(new Error("unexpected_advance")),
      close: () => { resource.closed = true; return Promise.resolve(); },
    };
    this.resources.push(resource);
    return resource.root;
  }
}

class FakeToolsFactory implements RootToolsFactoryInterface {
  readonly tools: RootToolExecutor[] = [];

  create() {
    const tools: RootToolExecutor = {
      execute: (call: RootToolCall) => Promise.reject(new Error(`unexpected_tool:${call.tool}`)),
    };
    this.tools.push(tools);
    return tools;
  }
}

test("registry keeps two Root runtimes and every owned resource disjoint", async () => {
  const fixture = await homes();
  const roots = new FakeRootFactory();
  const tools = new FakeToolsFactory();
  const registry = new RootRuntimeRegistry(fixture.manager, roots, tools);
  const first = await registry.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-1"),
  });
  const second = await registry.create({
    root_id: parseRootIssueId("LIN-2"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-2"),
  });

  assert.equal(registry.size, 2);
  assert.notEqual(first, second);
  assert.notEqual(first.rootHome, second.rootHome);
  assert.notEqual(first.reconcill, second.reconcill);
  assert.notEqual(first.tools, second.tools);
  for (const key of ["process", "thread", "baseline", "correlations"] as const) {
    assert.notEqual(roots.resources[0]?.[key], roots.resources[1]?.[key]);
  }
  await assert.rejects(registry.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-1"),
  }), /root_runtime_already_exists/u);

  await registry.close(parseRootIssueId("LIN-1"));
  assert.equal(roots.resources[0]?.closed, true);
  assert.equal(roots.resources[1]?.closed, false);
  assert.equal(registry.has(parseRootIssueId("LIN-2")), true);
});

test("registry reserves a Root during creation and rejects aliased factory objects", async () => {
  const fixture = await homes();
  let release: (() => void) | undefined;
  const root = new Promise<RootReconcillInterface>((resolve) => {
    release = () => resolve({
      rootId: parseRootIssueId("LIN-1"), runtimeGeneration: parseRuntimeGeneration(1),
      bootstrap: () => Promise.reject(new Error("unexpected")), advance: () => Promise.reject(new Error("unexpected")), close: () => Promise.resolve(),
    });
  });
  const waitingFactory: RootReconcillFactoryInterface = { create: () => root };
  const registry = new RootRuntimeRegistry(fixture.manager, waitingFactory, new FakeToolsFactory());
  const pending = registry.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-1"),
  });
  await assert.rejects(registry.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-1"),
  }), /root_runtime_already_exists/u);
  release?.();
  await pending;

  const otherHomes = await homes();
  const sharedRoot = {
    rootId: parseRootIssueId("LIN-3"), runtimeGeneration: parseRuntimeGeneration(1),
    bootstrap: () => Promise.reject(new Error("unexpected")), advance: () => Promise.reject(new Error("unexpected")), close: () => Promise.resolve(),
  } satisfies RootReconcillInterface;
  const aliasRegistry = new RootRuntimeRegistry(otherHomes.manager, { create: () => Promise.resolve(sharedRoot) }, new FakeToolsFactory());
  await aliasRegistry.create({
    root_id: parseRootIssueId("LIN-3"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-3"),
  });
  await assert.rejects(aliasRegistry.create({
    root_id: parseRootIssueId("LIN-4"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-4"),
  }), /root_runtime_resource_alias/u);
});

test("registry closes a newly-created Root when tool construction fails", async () => {
  const fixture = await homes();
  const roots = new FakeRootFactory();
  const registry = new RootRuntimeRegistry(fixture.manager, roots, {
    create: () => { throw new Error("sensitive_factory_failure"); },
  });
  await assert.rejects(registry.create({
    root_id: parseRootIssueId("LIN-1"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-1"),
  }), (error: Error) => {
    assert.equal(error.message, "root_tools_creation_failed");
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });
  assert.equal(roots.resources[0]?.closed, true);
  assert.equal(registry.size, 0);
});

test("two registry Roots start and stop separate installed Codex process boundaries", { timeout: 30_000 }, async () => {
  const fixture = await homes();
  const transportFactory = new CodexRootTurnTransportFactory({
    executable: "codex",
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 10_000,
    shutdownTimeoutMs: 2_000,
    apiKey: "test-api-key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
  });
  const registry = new RootRuntimeRegistry(
    fixture.manager,
    new RootReconcillFactory(transportFactory),
    new FakeToolsFactory(),
  );
  const first = await registry.create({
    root_id: parseRootIssueId("LIN-10"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-10"),
  });
  const second = await registry.create({
    root_id: parseRootIssueId("LIN-20"), runtime_generation: parseRuntimeGeneration(1), workspace: workspace("LIN-20"),
  });
  assert.notEqual(first.rootHome, second.rootHome);
  assert.notEqual(first.reconcill, second.reconcill);
  await registry.closeAll();
  assert.equal(registry.size, 0);
});
