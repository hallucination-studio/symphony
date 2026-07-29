import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";
import type { RootStateStageSessionFence } from "./RootStateStageInterruptionCompilerInterface.js";

export interface RootStateRepeatedFindingExhaustedCycleCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    cycleIssueId: string;
    findingIssueIds: readonly string[];
    maxSameOpenFindingCycles: number;
    sessionFence: RootStateStageSessionFence;
  }): RootStateMechanicalCompilerResult;
}
