import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalConvergenceCompilerResult } from "./RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "./RootTransitionPolicyInterface.js";

export interface InvalidExecutionGenerationCompilerInterface {
  compile(input: {
    target: Extract<RootMechanicalTarget, { kind: "converge_invalid_execution_generation" }>;
    view: RootReconciliationView;
  }): RootMechanicalConvergenceCompilerResult;
}
