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
        return result.kind === "blocked"
          ? needsAttention("root_cancellation_reconciliation_needs_attention")
          : { kind: "progress" as const };
      } catch (error) {
        return needsAttention(`root_cancellation_reconciliation_failed:${sanitize(error)}`);
      }
    }
    const profile = await this.dependencies.profileFor(input.view);
    if (!profile) return needsAttention("root_stage_profile_not_ready");
    const cycle = activeCycle(input.view);
    const stage = stageFor(cycle);
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
        return { kind: result.kind === "awaiting_human" ? "waiting-human" as const : "progress" as const };
      }
      if (stage === "work") {
        const result = await this.dependencies.execution.executeWorkStage(shared as WorkStageInput);
        return { kind: result.kind === "awaiting_human" ? "waiting-human" as const : "progress" as const };
      }
      const result = await this.dependencies.execution.executeVerifyStage(shared as VerifyStageInput);
      return { kind: result.kind === "awaiting_human" ? "waiting-human" as const : "progress" as const };
    } catch (error) {
      return needsAttention(`root_stage_dispatch_failed:${sanitize(error)}`);
    }
  }
}

function needsAttention(sanitizedReason: string) {
  return { kind: "needs-attention" as const, sanitizedReason };
}

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .slice(0, 1_900);
}

function activeCycle(view: RootDagView): RootCycleView | undefined {
  return view.cycles.find(({ issue }) => ![
    "Succeeded", "Changes Required", "Canceled",
  ].includes(issue.status_name));
}

function stageFor(cycle: RootCycleView | undefined): "plan" | "work" | "verify" {
  if (!cycle) return "plan";
  if (["Verifying", "Inconclusive", "Escalated"].includes(cycle.issue.status_name)) {
    return "verify";
  }
  if (!["Sealed", "Executing"].includes(cycle.issue.status_name)) return "plan";
  const work = cycle.nodes.filter((node) => node.issue.issue_kind === "work");
  const verify = cycle.nodes.find((node) => node.issue.issue_kind === "verify");
  const workComplete = work.length > 0 && work.every((node) =>
    node.issue.status_name === "Done" && node.records.some((record) =>
      record.kind === "work_completion" &&
      record.nodeIssueId === node.issue.issue_id &&
      record.workKey === node.marker.nodeKey));
  return workComplete && verify && ["Todo", "In Progress"].includes(verify.issue.status_name)
    ? "verify"
    : "work";
}
