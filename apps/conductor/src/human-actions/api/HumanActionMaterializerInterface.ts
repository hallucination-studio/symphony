import type { EvidenceRef, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";

export type HumanActionMaterializationResult =
  | { kind: "materialized"; requestCommentId: string }
  | { kind: "failed"; code: string; sanitizedReason: string };

export type HumanActionSummaryConvergenceResult =
  | { kind: "not_applicable" | "satisfied" }
  | { kind: "materialized"; desiredStatus: "Needs Approval" | "Needs Info" | "In Progress" }
  | { kind: "failed"; code: string; sanitizedReason: string };

export type HumanActionKind = "plan_approval" | "information" | "permission" | "finding_waiver" | "root_decision";

export interface HumanActionRequest {
  actionKind: HumanActionKind;
  targetIssueIds: string[];
  question: string;
  context: string;
  options: string[];
  evidenceRefs: EvidenceRef[];
}

export interface HumanActionMaterializerInterface {
  materialize(input: {
    request: HumanActionRequest;
    operationId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionMaterializationResult>;
  convergeRootSummary(input: {
    operationId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionSummaryConvergenceResult>;
}
