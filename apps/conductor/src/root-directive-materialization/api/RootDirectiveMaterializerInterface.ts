import type {
  RootDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type RootDirectiveMaterializationResult =
  | { kind: "materialized"; rootDirectiveId: string; sourceIssueIds: string[] }
  | { kind: "waiting"; rootDirectiveId: string; reason: string }
  | { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string };

export interface RootDirectiveMaterializerInterface {
  materialize(input: {
    directive: RootDirective;
    view: RootReconciliationView;
  }): Promise<RootDirectiveMaterializationResult>;
}
