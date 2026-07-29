import type { RootIssueId, RuntimeGeneration } from "../contracts/identity.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { RootReconcillFactoryInterface, RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import type { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import { RootRuntime, type RootToolExecutor, type RootToolsFactoryInterface } from "./RootRuntime.js";

export interface CreateRootRuntimeInput {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly workspace: RootWorkspaceIdentity;
}

export class RootRuntimeRegistry {
  readonly #runtimes = new Map<RootIssueId, RootRuntime>();
  readonly #creating = new Set<RootIssueId>();
  readonly #reconcills = new Set<RootReconcillInterface>();
  readonly #tools = new Set<RootToolExecutor>();
  readonly #toolResources = new Map<RootRuntime, RootToolExecutor>();

  constructor(
    private readonly homes: RootHomeManager,
    private readonly reconcillFactory: RootReconcillFactoryInterface,
    private readonly toolsFactory: RootToolsFactoryInterface,
  ) {}

  get size(): number { return this.#runtimes.size; }

  has(rootId: RootIssueId): boolean { return this.#runtimes.has(rootId); }

  get(rootId: RootIssueId): RootRuntime {
    const runtime = this.#runtimes.get(rootId);
    if (!runtime) throw new Error("root_runtime_not_found");
    return runtime;
  }

  async create(input: CreateRootRuntimeInput): Promise<RootRuntime> {
    if (input.workspace.root_id !== input.root_id) throw new Error("root_workspace_identity_mismatch");
    if (this.#runtimes.has(input.root_id) || this.#creating.has(input.root_id)) {
      throw new Error("root_runtime_already_exists");
    }
    this.#creating.add(input.root_id);
    try {
      const home = await this.homes.open(input.root_id);
      const reconcill = await this.reconcillFactory.create({
        root_id: input.root_id,
        runtime_generation: input.runtime_generation,
        root_home: home.path,
      });
      if (this.#reconcills.has(reconcill)) throw new Error("root_runtime_resource_alias");
      if (reconcill.rootId !== input.root_id || reconcill.runtimeGeneration !== input.runtime_generation) {
        await reconcill.close();
        throw new Error("root_runtime_identity_mismatch");
      }
      let tools: RootToolExecutor;
      try {
        tools = this.toolsFactory.create(input);
      } catch {
        await reconcill.close();
        throw new Error("root_tools_creation_failed");
      }
      if (this.#tools.has(tools)) {
        await reconcill.close();
        throw new Error("root_runtime_resource_alias");
      }
      const runtime = new RootRuntime(home.path, reconcill, tools);
      this.#reconcills.add(reconcill);
      this.#tools.add(tools);
      this.#toolResources.set(runtime, tools);
      this.#runtimes.set(input.root_id, runtime);
      return runtime;
    } finally {
      this.#creating.delete(input.root_id);
    }
  }

  async close(rootId: RootIssueId): Promise<void> {
    const runtime = this.get(rootId);
    const tools = this.#toolResources.get(runtime);
    if (!tools) throw new Error("root_runtime_resource_missing");
    await runtime.close();
    this.#runtimes.delete(rootId);
    this.#reconcills.delete(runtime.reconcill);
    this.#tools.delete(tools);
    this.#toolResources.delete(runtime);
  }

  async closeAll(): Promise<void> {
    for (const rootId of [...this.#runtimes.keys()]) await this.close(rootId);
  }
}
