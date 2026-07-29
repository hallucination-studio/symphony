import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalEffect } from "./RootStateMechanicalEffect.js";
import type { RootStateWorktreeFence } from "./RootStateWorktreeFence.js";

export interface RootStateTerminalSuccessorIntent {
  semanticGate: "terminal_review";
  rootIssueId: string;
  basedOnRootDigest: string;
  consumedInputIds: readonly string[];
  commentDispositions: readonly {
    kind: "applied" | "not_applied" | "needs_response" | "answer_only";
    sourceInputId: string;
  }[];
  intent: {
    kind: "start_successor_cycle";
    successorObjective: string;
    requiredOutcomes: readonly string[];
    preservedConstraints: readonly string[];
  };
}

export interface RootStateTerminalSuccessorSubject {
  rootIssueId: string;
  terminalCycleIssueId: string;
  cycleOutcome: "successful";
  verifyClassification: "passed";
  findingClassification: "none_open";
  successorCyclePolicy: "allowed" | "cycle_limit_reached" | "root_deadline_reached";
  exactRevision: string;
  pendingInputIds: readonly string[];
}

export type RootStateTerminalSuccessorCompilerResult =
  | { kind: "effect"; effect: RootStateMechanicalEffect }
  | { kind: "satisfied" }
  | {
      kind: "invalid_intent";
      reason:
        | "gate_mismatch"
        | "subject_stale"
        | "topology_invalid"
        | "input_disposition_invalid"
        | "purpose_incompatible"
        | "successor_prohibited"
        | "status_catalog_invalid"
        | "intent_content_invalid";
    };

export interface RootStateTerminalSuccessorCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    subject: RootStateTerminalSuccessorSubject;
    intent: RootStateTerminalSuccessorIntent;
    worktreeFence: RootStateWorktreeFence;
    observedAt: string;
    policy: {
      maxCyclesPerRoot: number;
      deadlineAt: string;
    };
  }): RootStateTerminalSuccessorCompilerResult;
}
