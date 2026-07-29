import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";

export type RootStateExecutionGenerationFence = "invalid" | "valid" | "uncertain";

export interface RootStateInvalidExecutionGenerationCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    cycleIssueId: string;
    executionGenerationFence: RootStateExecutionGenerationFence;
  }): RootStateMechanicalCompilerResult;
}
