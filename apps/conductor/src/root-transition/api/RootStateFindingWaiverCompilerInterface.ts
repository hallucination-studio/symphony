import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalCompilerResult } from "./RootStateMechanicalCompilerResult.js";

export interface RootStateFindingWaiverCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    cycleIssueId: string;
    requestCommentId: string;
    humanReplyCommentId: string;
    adoptionCommentId: string;
    findingIssueIds: readonly string[];
  }): RootStateMechanicalCompilerResult;
}
