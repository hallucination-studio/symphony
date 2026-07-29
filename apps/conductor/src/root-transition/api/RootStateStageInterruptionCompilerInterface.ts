import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";

export type RootStateStageSessionFence = "active" | "closed" | "uncertain";

export interface RootStateStageInterruptionCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    role: "plan" | "work" | "verify";
    cycleIssueId: string;
    stageIssueId: string;
    sessionFence: RootStateStageSessionFence;
  }): RootStateMechanicalCompilerResult;
}
