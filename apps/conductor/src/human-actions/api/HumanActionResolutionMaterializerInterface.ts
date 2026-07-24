import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionResolution } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { HumanActionResolutionRecord } from "../../root-reconciliation/api/ManagedRecords.js";

export type HumanActionResolutionMaterializationResult =
  | { kind: "materialized"; record: HumanActionResolutionRecord }
  | { kind: "failed"; code: string; sanitizedReason: string };

export interface HumanActionResolutionMaterializerInterface {
  materialize(input: {
    resolution: HumanActionResolution;
    actionKind: HumanActionResolutionRecord["actionKind"];
    tree: LinearWorkflowTreeSnapshot;
    rootIssueId: string;
  }): Promise<HumanActionResolutionMaterializationResult>;
}
