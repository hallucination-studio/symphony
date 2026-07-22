import { discoverCurrentRoots } from "../root-discovery/MultiRootDiscoveryPolicy.js";
import type { RootOwnershipClaimResult } from "../root-discovery/api/RootOwnershipClaimInterface.js";
import type { RootSchedulingPolicyInterface } from "../root-scheduling/api/RootSchedulingPolicyInterface.js";
import type { DiscoveredRoot } from "../root-workflow/api/Models.js";
import type { RootDagView, RootWorkflowPolicyInterface } from "../root-workflow/api/RootWorkflowPolicyInterface.js";
import type { ConductorCycleDisposition } from "./ConductorCycleDelayPolicy.js";

export interface RuntimeReporter {
  report(input: {
    status: "ready" | "blocked";
    sanitizedReason?: string;
    rootId?: string;
  }): Promise<void>;
}

export interface LinearWorkflowRuntimeGateway {
  resolveProject(): Promise<
    | { kind: "resolved"; projectId: string }
    | { kind: "unbound" | "ambiguous" | "label_conflict" }
  >;
  listRoots(projectId: string): Promise<DiscoveredRoot[]>;
  admitRoot(root: DiscoveredRoot): Promise<RootOwnershipClaimResult>;
  readRootDag(rootIssueId: string): Promise<RootDagView>;
}

export interface LinearWorkflowStageDispatcher {
  dispatch(input: { root: DiscoveredRoot; view: RootDagView }): Promise<
    | { kind: "progress" | "waiting-human" }
    | { kind: "needs-attention"; sanitizedReason: string }
  >;
}

export class LinearConductorRuntime {
  constructor(
    private readonly conductorId: string,
    private readonly gateway: LinearWorkflowRuntimeGateway,
    private readonly scheduling: RootSchedulingPolicyInterface,
    private readonly workflow: RootWorkflowPolicyInterface,
    private readonly dispatcher: LinearWorkflowStageDispatcher,
    private readonly reporter: RuntimeReporter,
  ) {}

  async cycle(): Promise<ConductorCycleDisposition> {
    try {
      const project = await this.gateway.resolveProject();
      if (project.kind !== "resolved") {
        await this.reporter.report({ status: "blocked", sanitizedReason: `project_${project.kind}` });
        return "needs-attention";
      }
      const roots = discoverCurrentRoots({
        projectId: project.projectId,
        roots: await this.gateway.listRoots(project.projectId),
        conductorId: this.conductorId,
      });
      const scheduled = this.scheduling.evaluate(roots);
      let waitingHuman = false;
      let needsAttention = scheduled.blocked.length > 0;
      for (const root of scheduled.orderedEligible) {
        let admission: RootOwnershipClaimResult;
        try {
          admission = await this.gateway.admitRoot(root);
        } catch (error) {
          needsAttention = true;
          await this.reporter.report({
            status: "blocked",
            rootId: root.issueId,
            sanitizedReason: `root_admission_failed:${sanitize(error).slice(0, 2000)}`,
          });
          continue;
        }
        if (admission.kind !== "claimed" && admission.kind !== "already_owned") {
          needsAttention = true;
          await this.reporter.report({
            status: "blocked",
            rootId: root.issueId,
            sanitizedReason: `root_admission_${admission.kind}`,
          });
          continue;
        }
        const view = await this.gateway.readRootDag(root.issueId);
        const assessment = this.workflow.assess(view);
        if (view.root.issue.status_name === "Canceled") {
          const result = await this.dispatcher.dispatch({ root, view });
          await this.reporter.report({
            status: result.kind === "needs-attention" ? "blocked" : "ready",
            rootId: root.issueId,
            ...(result.kind === "needs-attention"
              ? { sanitizedReason: result.sanitizedReason }
              : {}),
          });
          if (result.kind === "progress") return "progress";
          needsAttention ||= result.kind === "needs-attention";
          continue;
        }
        if (assessment.readiness === "waiting_human") {
          waitingHuman = true;
          continue;
        }
        if (assessment.readiness !== "runnable") {
          needsAttention ||= assessment.readiness === "needs_attention";
          continue;
        }
        const result = await this.dispatcher.dispatch({ root, view });
        await this.reporter.report({
          status: result.kind === "needs-attention" ? "blocked" : "ready",
          rootId: root.issueId,
          ...(result.kind === "needs-attention"
            ? { sanitizedReason: result.sanitizedReason }
            : {}),
        });
        if (result.kind === "progress") return "progress";
        waitingHuman ||= result.kind === "waiting-human";
        needsAttention ||= result.kind === "needs-attention";
      }
      await this.reporter.report({ status: "ready" });
      if (waitingHuman) return "waiting-human";
      return needsAttention || roots.length > 0 ? "needs-attention" : "empty";
    } catch (error) {
      await this.reporter.report({ status: "blocked", sanitizedReason: sanitize(error) });
      return "needs-attention";
    }
  }
}

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 2048);
}
