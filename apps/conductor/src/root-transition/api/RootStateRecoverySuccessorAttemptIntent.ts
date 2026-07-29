export interface RootStateRecoverySuccessorAttemptIntent {
  semanticGate: "recovery_strategy";
  rootIssueId: string;
  basedOnRootDigest: string;
  consumedInputIds: readonly string[];
  commentDispositions: readonly {
    kind: "applied" | "not_applied" | "needs_response" | "answer_only";
    sourceInputId: string;
  }[];
  intent: {
    kind: "continue_with_successor_attempt";
    attemptGoal: string;
    successEvidenceRequirements: readonly string[];
  };
}
