import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalConvergenceCompilerResult } from "./RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "./RootTransitionPolicyInterface.js";

export interface StageInterruptionCompilerInput {
  target: Extract<RootMechanicalTarget, { kind: "interrupt_stage" }>;
  view: RootReconciliationView;
}

export interface StageInterruptionCompilerInterface {
  compile(input: StageInterruptionCompilerInput): RootMechanicalConvergenceCompilerResult;
}
