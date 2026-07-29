import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";
import type { RootStateStageSessionFence } from "./RootStateStageInterruptionCompilerInterface.js";

export type RootStateDeadlineTarget =
  | { kind: "cycle"; cycleIssueId: string; sessionFence: RootStateStageSessionFence }
  | { kind: "root" };

export interface RootStateDeadlineExceededCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    target: RootStateDeadlineTarget;
    deadlineAt: string;
    observedAt: string;
  }): RootStateMechanicalCompilerResult;
}
