import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";
import type { RootStateStageSessionFence } from "./RootStateStageInterruptionCompilerInterface.js";

export interface RootStateRepairExhaustedCycleCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    cycleIssueId: string;
    maxCycleRepairAttempts: number;
    sessionFence: RootStateStageSessionFence;
  }): RootStateMechanicalCompilerResult;
}
