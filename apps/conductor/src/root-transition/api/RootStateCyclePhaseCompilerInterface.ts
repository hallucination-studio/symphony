import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";

export type RootStateCyclePhaseCompilerResult = RootStateMechanicalCompilerResult;

export interface RootStateCyclePhaseCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    cycleIssueId: string;
    desiredStatus: "Executing" | "Verifying";
  }): RootStateCyclePhaseCompilerResult;
}
