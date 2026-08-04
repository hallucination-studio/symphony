import type { RootIssueId, RuntimeGeneration } from "../../contracts/identity.js";
import type { RootBootstrap, RootFactDiff, RootSemanticSnapshot } from "../../contracts/observation.js";
import type { RootTurnOutcome } from "../../contracts/runtime.js";

export type RootReconcillInput = RootBootstrap | RootFactDiff | RootSemanticSnapshot;

export interface RootReconcillInterface {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  run(input: RootReconcillInput): Promise<RootTurnOutcome>;
  close(): Promise<void>;
}

export interface RootReconcillFactoryInput {
  readonly root_id: RootIssueId;
  readonly runtime_generation: RuntimeGeneration;
  readonly root_home: string;
}

export interface RootReconcillFactoryInterface {
  create(input: RootReconcillFactoryInput): Promise<RootReconcillInterface>;
}
