import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";
import type { RootStateWorktreeFence } from "./RootStateWorktreeFence.js";

export interface RootStateAuthorizedTerminalSuccessorCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    predecessorCycleIssueId: string;
    successorCycleIssueId: string;
    worktreeFence: RootStateWorktreeFence;
    observedAt: string;
    policy: {
      maxCyclesPerRoot: number;
      deadlineAt: string;
    };
  }): RootStateMechanicalCompilerResult;
}
