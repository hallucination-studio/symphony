import type { GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  ConvergenceRecord,
} from "./ManagedRecords.js";
import type { DiscoveredRoot } from "./RootModels.js";
import type { RootConvergenceSnapshot } from "./RootReconciliationContracts.js";
import type { ConvergenceTriggerInput } from "./RootConvergence.js";

export interface RootConvergenceAssessment {
  snapshot: RootConvergenceSnapshot;
  trigger: ConvergenceTriggerInput;
  record?: ConvergenceRecord;
}

export interface RootConvergencePolicyInterface {
  assess(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
    git: GitWorkspaceSnapshot;
  }): RootConvergenceAssessment;
  persistNonAllowing(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
    assessment: RootConvergenceAssessment;
  }): Promise<LinearWorkflowTreeSnapshot>;
}

export type RootConvergenceLinearGateway = Pick<
  LinearGatewayInterface,
  "readWorkflowIssueTree" | "mutateWorkflow"
>;
