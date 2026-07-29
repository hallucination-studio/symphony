import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalEffect } from "./RootStateMechanicalEffect.js";
import type {
  RootStateRecoverySuccessorAttemptIntent,
} from "./RootStateRecoverySuccessorAttemptIntent.js";
import type { RootStateStageSessionFence } from "./RootStateStageInterruptionCompilerInterface.js";
import type { RootStateWorktreeFence } from "./RootStateWorktreeFence.js";

export type RootStateInterruptedExecutionSuccessorIntent = RootStateRecoverySuccessorAttemptIntent;

export type RootStateInterruptedExecutionSuccessorCompilerResult =
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

export interface RootStateInterruptedExecutionSuccessorCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    subject: {
      rootIssueId: string;
      cycleIssueId: string;
      stageIssueId: string;
      role: "work" | "verify";
      exactRevision: string;
      pendingInputIds: readonly string[];
    };
    intent: RootStateInterruptedExecutionSuccessorIntent;
    worktreeFence: RootStateWorktreeFence;
    sessionFence: RootStateStageSessionFence;
    observedAt: string;
    policy: {
      maxCyclesPerRoot: number;
      deadlineAt: string;
    };
  }): RootStateInterruptedExecutionSuccessorCompilerResult;
}
