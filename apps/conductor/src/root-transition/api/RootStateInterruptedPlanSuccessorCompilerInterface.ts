import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";
import type { RootStateWorktreeFence } from "./RootStateWorktreeFence.js";

export interface RootStateInterruptedPlanSuccessorCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    cycleIssueId: string;
    predecessorPlanIssueId: string;
    successorPlanIssueId: string;
    worktreeFence: RootStateWorktreeFence;
  }): RootStateMechanicalCompilerResult;
}
