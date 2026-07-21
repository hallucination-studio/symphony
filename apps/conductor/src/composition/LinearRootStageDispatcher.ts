import type {
  BootstrapPlanInput,
  LinearDagExecutionInterface,
  VerifyStageInput,
  WorkStageInput,
} from "../linear-dag/api/LinearDagExecutionInterface.js";
import type { GitWorkspace } from "../git-workspaces/api/GitWorkspaceInterface.js";
import type { DiscoveredRoot, RootCycleView, RootDagView } from "../root-workflow/api/index.js";
import type { PerformerProfile } from "../performer-profiles/api/PerformerProfileStoreInterface.js";
import type { LinearWorkflowStageDispatcher } from "./ConductorRuntime.js";

type StageOptions = BootstrapPlanInput["options"];

export interface LinearRootStageDispatcherDependencies {
  execution: LinearDagExecutionInterface;
  profileFor(view: RootDagView): Promise<PerformerProfile | undefined>;
  workspaceFor(root: DiscoveredRoot): GitWorkspace;
  optionsFor(input: {
    root: DiscoveredRoot;
    view: RootDagView;
    profile: PerformerProfile;
    stage: "plan" | "work" | "verify";
  }): StageOptions;
}

export class LinearRootStageDispatcher implements LinearWorkflowStageDispatcher {
  constructor(private readonly dependencies: LinearRootStageDispatcherDependencies) {}

  async dispatch(input: { root: DiscoveredRoot; view: RootDagView }) {
    const workspace = this.dependencies.workspaceFor(input.root);
    if (input.view.root.issue.status_name === "Canceled") {
      try {
        const result = await this.dependencies.execution.reconcileCanceledRoot({
          rootIssueId: input.root.issueId,
          projectId: input.root.projectId,
          workspace,
        });
        return result.kind === "blocked" ? "needs-attention" as const : "progress" as const;
      } catch {
        return "needs-attention" as const;
      }
    }
    const profile = await this.dependencies.profileFor(input.view);
    if (!profile) return "needs-attention" as const;
    const cycle = activeCycle(input.view);
    const stage = cycle && ["Sealed", "Executing"].includes(cycle.issue.status_name)
      ? "work"
      : cycle && ["Verifying", "Inconclusive", "Escalated"].includes(cycle.issue.status_name)
        ? "verify"
        : "plan";
    const options = this.dependencies.optionsFor({ ...input, profile, stage });
    const shared = {
      rootIssueId: input.root.issueId,
      projectId: input.root.projectId,
      workspace,
      options,
    };

    try {
      if (stage === "plan") {
        const result = await this.dependencies.execution.executeBootstrapPlan(shared);
        return result.kind === "awaiting_human" ? "waiting-human" as const : "progress" as const;
      }
      if (stage === "work") {
        const result = await this.dependencies.execution.executeWorkStage(shared as WorkStageInput);
        return result.kind === "awaiting_human" ? "waiting-human" as const : "progress" as const;
      }
      const result = await this.dependencies.execution.executeVerifyStage(shared as VerifyStageInput);
      return result.kind === "awaiting_human" ? "waiting-human" as const : "progress" as const;
    } catch {
      return "needs-attention" as const;
    }
  }
}

function activeCycle(view: RootDagView): RootCycleView | undefined {
  return view.cycles.find(({ issue }) => ![
    "Succeeded", "Changes Required", "Canceled",
  ].includes(issue.status_name));
}
