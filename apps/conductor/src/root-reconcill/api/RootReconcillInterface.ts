import type { RootIssueId, RuntimeGeneration } from "../../contracts/identity.js";
import type { RootBootstrap, RootObservationDiff } from "../../contracts/observation.js";
import type { RootOutput } from "../../contracts/root-interaction.js";

export interface RootReconcillInterface {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  bootstrap(input: RootBootstrap): Promise<RootOutput>;
  advance(input: RootObservationDiff): Promise<RootOutput>;
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
