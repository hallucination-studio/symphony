import type { RootStateMechanicalEffect } from "./RootStateMechanicalEffect.js";

export type RootStateMechanicalCompilerResult =
  | { kind: "effect"; effect: RootStateMechanicalEffect }
  | { kind: "satisfied" }
  | {
      kind: "invalid_facts";
      reason: "mechanical_precondition_invalid" | "status_catalog_invalid" | "topology_invalid";
    };
