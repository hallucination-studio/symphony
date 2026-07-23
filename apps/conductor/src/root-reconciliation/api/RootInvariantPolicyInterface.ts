import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { DiscoveredRoot } from "./RootModels.js";

export type RootInvariantValidationResult =
  | { kind: "valid" }
  | { kind: "invalid"; reason: string };

export interface RootInvariantPolicyInterface {
  validate(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
  }): RootInvariantValidationResult;
}
