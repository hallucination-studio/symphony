import type {
  RequestHumanActionDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type HumanActionMaterializationResult =
  | { kind: "materialized"; actionIssueId: string; actionId: string }
  | { kind: "failed"; code: string; sanitizedReason: string };

export interface HumanActionMaterializerInterface {
  materialize(input: {
    directive: RequestHumanActionDirective;
    rootDirectiveId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionMaterializationResult>;
}
