import type { LinearWorkflowMutationCommand } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootBootstrap, RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalTarget } from "./RootTransitionPolicyInterface.js";

export type RootMechanicalConvergenceCompilerResult =
  | { kind: "effect"; command: LinearWorkflowMutationCommand }
  | { kind: "satisfied"; sealDigest?: string }
  | { kind: "invalid_facts"; reason: "target_stale" | "status_catalog_invalid" | "topology_invalid" };

export interface RootMechanicalConvergenceCompilerInput {
  target: RootMechanicalTarget;
  facts: RootBootstrap;
  view: RootReconciliationView;
}

export interface RootMechanicalConvergenceCompilerInterface {
  compile(input: RootMechanicalConvergenceCompilerInput): RootMechanicalConvergenceCompilerResult;
}
