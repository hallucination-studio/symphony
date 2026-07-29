import type { RootIssueId, RuntimeGeneration } from "../contracts/identity.js";
import type { RootToolCall } from "../contracts/root-interaction.js";
import type { RootWorkspaceIdentity } from "../git/api/GitWorkspaceInterface.js";
import type { RootReconcillInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import type { RootToolResult } from "./RootTools.js";

export interface RootToolExecutor {
  execute(call: RootToolCall): Promise<RootToolResult>;
}

export interface RootToolsFactoryInput {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly workspace: RootWorkspaceIdentity;
}

export interface RootToolsFactoryInterface {
  create(input: RootToolsFactoryInput): RootToolExecutor;
}

export class RootRuntime {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  readonly tools: RootToolExecutor;
  readonly #inFlightTools = new Set<Promise<RootToolResult>>();
  #acceptingTools = true;
  #closing: Promise<void> | null = null;

  constructor(
    readonly rootHome: string,
    readonly reconcill: RootReconcillInterface,
    tools: RootToolExecutor,
  ) {
    this.rootId = reconcill.rootId;
    this.runtimeGeneration = reconcill.runtimeGeneration;
    this.tools = Object.freeze({ execute: (call: RootToolCall) => this.#executeTool(tools, call) });
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#acceptingTools = false;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #executeTool(delegate: RootToolExecutor, call: RootToolCall): Promise<RootToolResult> {
    if (!this.#acceptingTools) throw new Error("root_tools_closed");
    const execution = Promise.resolve().then(() => delegate.execute(call));
    this.#inFlightTools.add(execution);
    void execution.then(
      () => this.#inFlightTools.delete(execution),
      () => this.#inFlightTools.delete(execution),
    );
    return execution;
  }

  async #close(): Promise<void> {
    const results = await Promise.allSettled([
      this.reconcill.close(),
      Promise.allSettled([...this.#inFlightTools]),
    ]);
    if (results.some(({ status }) => status === "rejected")) {
      throw new Error("root_runtime_close_failed");
    }
  }
}
