import { discoverCurrentRoots } from "../root-discovery/MultiRootDiscoveryPolicy.js";
import type { AgentSymphonyHarnessInterface } from "../agent-symphony-harness/api/AgentSymphonyHarnessInterface.js";
import type { RootSchedulingPolicyInterface } from "../root-scheduling/api/RootSchedulingPolicyInterface.js";
import type { DiscoveredRoot, V3RootRunView } from "../root-workflow/api/index.js";
import type { ConductorCycleDisposition } from "./ConductorCycleDelayPolicy.js";

export interface V3RuntimeGateway {
  resolveProject(): Promise<
    | { kind: "resolved"; projectId: string }
    | { kind: "unbound" | "ambiguous" | "label_conflict" }
  >;
  listRoots(projectId: string): Promise<
    DiscoveredRoot[]
  >;
  listRootPages?(projectId: string): AsyncIterable<{
    roots: DiscoveredRoot[];
    hasNextPage: boolean;
    ordering: "scheduling" | "unsupported";
  }>;
  reconstructV3(rootId: string): Promise<V3RootRunView>;
}

export interface RuntimeReporter {
  report(input: { status: "ready" | "blocked"; sanitizedReason?: string;
    rootId?: string }): Promise<void>;
}

export class V3ConductorRuntime {
  constructor(
    private readonly conductorId: string,
    private readonly gateway: V3RuntimeGateway,
    private readonly scheduling: RootSchedulingPolicyInterface,
    private readonly harness: AgentSymphonyHarnessInterface,
    private readonly reporter: RuntimeReporter,
  ) {}

  async cycle(): Promise<ConductorCycleDisposition> {
    try {
      const project = await this.gateway.resolveProject();
      if (project.kind !== "resolved") {
        await this.reporter.report({
          status: "blocked", sanitizedReason: `project_${project.kind}`,
        });
        return "needs-attention";
      }
      const roots = await this.#discoverRoots(project.projectId);
      const scheduling = this.scheduling.evaluate(roots);
      let waitingHuman = false;
      let needsAttention = false;
      for (const root of scheduling.orderedEligible) {
        const candidate = await this.gateway.reconstructV3(root.issueId);
        const assessment = this.harness.assessRoot(candidate);
        if (assessment.readiness !== "runnable") {
          waitingHuman ||= assessment.readiness === "waiting_human";
          needsAttention ||= assessment.readiness === "needs_attention";
          continue;
        }
        let claimedWrite = false;
        if (!candidate.managedComment) {
          const claimed = await this.harness.claimRoot(candidate);
          if (claimed.kind !== "ready") {
            await this.reporter.report({ status: "blocked", rootId: root.issueId,
              sanitizedReason: claimed.reason });
            return "needs-attention";
          }
          claimedWrite = true;
        }
        const result = await this.harness.runRootTurn(root.issueId);
        await this.reporter.report({
          status: result.kind === "failed" ? "blocked" : "ready",
          rootId: root.issueId,
          ...(result.kind === "failed"
            ? { sanitizedReason: result.sanitizedFailure }
            : {}),
        });
        if (claimedWrite || result.kind === "completed") return "progress";
        if (result.kind === "not_started") {
          return result.readiness === "waiting_human"
            ? "waiting-human"
            : "needs-attention";
        }
        return "needs-attention";
      }
      await this.reporter.report({ status: "ready" });
      if (waitingHuman) return "waiting-human";
      if (needsAttention || roots.length > 0) return "needs-attention";
      return "empty";
    } catch (error) {
      await this.reporter.report({
        status: "blocked", sanitizedReason: sanitize(error),
      });
      return "needs-attention";
    }
  }

  async #discoverRoots(projectId: string): Promise<DiscoveredRoot[]> {
    if (!this.gateway.listRootPages) {
      return discoverCurrentRoots({
        projectId,
        roots: await this.gateway.listRoots(projectId),
        conductorId: this.conductorId,
      });
    }
    const observed: DiscoveredRoot[] = [];
    for await (const page of this.gateway.listRootPages(projectId)) {
      observed.push(...page.roots);
      const current = discoverCurrentRoots({
        projectId,
        roots: observed,
        conductorId: this.conductorId,
      });
      const candidate = this.scheduling.evaluate(current).orderedEligible[0];
      const boundary = page.roots.at(-1);
      if (
        candidate &&
        page.hasNextPage &&
        page.ordering === "scheduling" &&
        boundary &&
        this.scheduling.strictlyOutranksBoundary(candidate, boundary)
      ) {
        return current;
      }
      if (!page.hasNextPage) return current;
    }
    throw new Error("linear_root_pages_incomplete");
  }
}


function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 2048);
}
