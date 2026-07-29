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

  constructor(
    readonly rootHome: string,
    readonly reconcill: RootReconcillInterface,
    readonly tools: RootToolExecutor,
  ) {
    this.rootId = reconcill.rootId;
    this.runtimeGeneration = reconcill.runtimeGeneration;
  }

  close(): Promise<void> {
    return this.reconcill.close();
  }
}
