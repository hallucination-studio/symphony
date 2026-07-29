import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalEffect } from "./RootStateMechanicalEffect.js";
import type { RootStateRecoverySuccessorAttemptIntent } from "./RootStateRecoverySuccessorAttemptIntent.js";
import type { RootStateStageSessionFence } from "./RootStateStageInterruptionCompilerInterface.js";
import type { RootStateWorktreeFence } from "./RootStateWorktreeFence.js";

export type RootStateInterruptedPlanSuccessorCreationCompilerResult =
  | { kind: "effect"; effect: RootStateMechanicalEffect }
  | { kind: "satisfied" }
  | {
      kind: "invalid_intent";
      reason:
        | "gate_mismatch"
        | "subject_stale"
        | "topology_invalid"
        | "input_disposition_invalid"
        | "purpose_incompatible"
        | "successor_prohibited"
        | "status_catalog_invalid"
        | "intent_content_invalid";
    };

export interface RootStateInterruptedPlanSuccessorCreationCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    subject: {
      rootIssueId: string;
      cycleIssueId: string;
      predecessorPlanIssueId: string;
      exactRevision: string;
      pendingInputIds: readonly string[];
    };
    intent: RootStateRecoverySuccessorAttemptIntent;
    worktreeFence: RootStateWorktreeFence;
    sessionFence: RootStateStageSessionFence;
    observedAt: string;
    deadlineAt: string;
  }): RootStateInterruptedPlanSuccessorCreationCompilerResult;
}
