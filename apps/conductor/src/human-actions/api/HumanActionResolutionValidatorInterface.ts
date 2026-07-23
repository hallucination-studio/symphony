import type { RootTree } from "../../root-reconciliation/api/RootReconciliationContracts.js";

export interface HumanActionResolutionValidatorInterface {
  validate(input: {
    tree: RootTree;
    actionIssueId: string;
  }): HumanActionResolutionValidationResult;
}

export type HumanActionResolutionValidationResult =
  | {
      kind: "valid";
      actionId: string;
      outcome: "approved" | "rejected" | "answered" | "canceled";
      sourceCommentIds: string[];
    }
  | { kind: "pending"; reason: "missing_reason" | "missing_answer" | "not_terminal" }
  | { kind: "invalid"; reason: string };
