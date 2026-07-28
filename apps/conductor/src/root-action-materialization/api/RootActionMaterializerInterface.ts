import type {
  RootDirective,
  RootReconciliationView,
  TreeOperation,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface RootActionFailureDiagnostic {
  operationGroup: "operations" | "archive_or_restore_operations" | "generated_archive_operations";
  operationIndex: number;
  operationKind: TreeOperation["kind"];
}

export type RootActionMaterializationResult =
  | { kind: "materialized"; rootDirectiveId: string; sourceIssueIds: string[] }
  | { kind: "waiting"; rootDirectiveId: string; reason: string }
  | { kind: "failed"; rootDirectiveId: string; code: string; sanitizedReason: string; diagnostic?: RootActionFailureDiagnostic };

export interface RootActionMaterializerInterface {
  materialize(input: {
    directive: RootDirective;
    view: RootReconciliationView;
  }): Promise<RootActionMaterializationResult>;
}
