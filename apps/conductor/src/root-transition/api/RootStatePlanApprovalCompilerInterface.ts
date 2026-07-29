import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalEffect } from "./RootStateMechanicalEffect.js";

export interface RootStatePlanApprovalIntent {
  semanticGate: "plan_human_decision";
  rootIssueId: string;
  basedOnRootDigest: string;
  pendingInputRefs: readonly {
    sourceKind: "comment_body";
    inputId: string;
    nativeSourceIdentity: string;
    sourceVersionOrDigest: string;
  }[];
  consumedInputIds: readonly string[];
  commentDispositions: readonly {
    kind: "applied";
    sourceInputId: string;
    source: {
      kind: "comment_body";
      commentId: string;
      commentBodyDigest: string;
    };
  }[];
  subject: {
    planIssueId: string;
    planContentDigest: string;
    approvalThreadRootCommentId: string;
    decisionReplyCommentId: string;
    decisionReplyBodyDigest: string;
    actorId: string;
    actorAuthorization: "authorized";
  };
  intent: { kind: "approve_plan" };
}

export type RootStatePlanApprovalCompilerResult =
  | { kind: "effect"; effect: RootStateMechanicalEffect }
  | { kind: "satisfied" }
  | {
      kind: "invalid_intent";
      reason:
        | "gate_mismatch"
        | "subject_stale"
        | "authorization_invalid"
        | "topology_invalid"
        | "input_disposition_invalid"
        | "decision_incompatible"
        | "status_catalog_invalid";
    };

export interface RootStatePlanApprovalCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    intent: RootStatePlanApprovalIntent;
  }): RootStatePlanApprovalCompilerResult;
}
