import type {
  CreateHumanActionAction,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type HumanActionMaterializationResult =
  | { kind: "materialized"; requestCommentId: string }
  | { kind: "failed"; code: string; sanitizedReason: string };

export interface HumanActionMaterializerInterface {
  materialize(input: {
    action: CreateHumanActionAction;
    rootDirectiveId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionMaterializationResult>;
}
