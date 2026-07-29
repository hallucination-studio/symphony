import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalConvergenceCompilerResult } from "./RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "./RootTransitionPolicyInterface.js";

export interface CyclePhaseCompilerInterface {
  compile(input: {
    target: Extract<RootMechanicalTarget, { kind: "advance_cycle_phase" }>;
    view: RootReconciliationView;
  }): RootMechanicalConvergenceCompilerResult;
}
