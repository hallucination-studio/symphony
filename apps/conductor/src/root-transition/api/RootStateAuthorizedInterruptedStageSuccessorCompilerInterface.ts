import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";
import type { RootStateStageSessionFence } from "./RootStateStageInterruptionCompilerInterface.js";
import type { RootStateWorktreeFence } from "./RootStateWorktreeFence.js";

export interface RootStateAuthorizedInterruptedStageSuccessorCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    predecessorCycleIssueId: string;
    successorCycleIssueId: string;
    interruptedStageIssueId: string;
    role: "work" | "verify";
    worktreeFence: RootStateWorktreeFence;
    sessionFence: RootStateStageSessionFence;
    observedAt: string;
    policy: {
      maxCyclesPerRoot: number;
      deadlineAt: string;
    };
  }): RootStateMechanicalCompilerResult;
}
