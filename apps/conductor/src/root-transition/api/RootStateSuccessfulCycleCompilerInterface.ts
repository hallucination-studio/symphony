import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";

export interface RootStateSuccessfulCycleCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    cycleIssueId: string;
    verifyIssueId: string;
  }): RootStateMechanicalCompilerResult;
}
