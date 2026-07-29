import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalEffect } from "./RootStateMechanicalEffect.js";
import type { RootStateRequirement } from "./RootStateRequirement.js";

export interface RootStateInitialRequirementIntent {
  semanticGate: "requirement_and_comment";
  rootIssueId: string;
  basedOnRootDigest: string;
  consumedInputIds: readonly string[];
  commentDispositions: readonly {
    kind: "applied" | "not_applied" | "needs_response" | "answer_only";
    sourceInputId: string;
  }[];
  intent: {
    kind: "define_requirement";
    requirement: RootStateRequirement;
    activeCycleImpact: "initial" | "compatible" | "requires_recovery";
  };
}

export type RootStateInitialRequirementCompilerResult =
  | { kind: "effect"; effect: RootStateMechanicalEffect }
  | {
      kind: "invalid_intent";
      reason:
        | "gate_mismatch"
        | "subject_stale"
        | "topology_invalid"
        | "input_disposition_invalid"
        | "impact_invalid"
        | "status_catalog_invalid"
        | "requirement_invalid";
    };

export interface RootStateInitialRequirementCompilerInterface {
  compile(input: {
    state: RecoveredRootState;
    intent: RootStateInitialRequirementIntent;
  }): RootStateInitialRequirementCompilerResult;
}
