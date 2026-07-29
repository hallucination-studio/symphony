import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";
import type { RootStateWorktreeFence } from "./RootStateWorktreeFence.js";

export interface RootStateInitialCyclePlanCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    worktreeFence: RootStateWorktreeFence;
  }): RootStateMechanicalCompilerResult;
}
