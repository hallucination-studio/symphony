import { discoverCurrentRoots } from "../root-discovery/MultiRootDiscoveryPolicy.js";
import type { AgentSymphonyHarnessInterface } from "../agent-symphony-harness/api/AgentSymphonyHarnessInterface.js";
import type { RootSchedulingPolicyInterface } from "../root-scheduling/api/RootSchedulingPolicyInterface.js";
import type { DiscoveredRoot, V3RootRunView } from "../root-workflow/api/index.js";

export interface V3RuntimeGateway {
  resolveProject(): Promise<
    | { kind: "resolved"; projectId: string }
    | { kind: "unbound" | "ambiguous" | "label_conflict" }
  >;
  listRoots(projectId: string): Promise<
    DiscoveredRoot[]
  >;
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

  async cycle() {
    try {
      const project = await this.gateway.resolveProject();
      if (project.kind !== "resolved") {
        await this.reporter.report({
          status: "blocked", sanitizedReason: `project_${project.kind}`,
        });
        return;
      }
      const roots = discoverCurrentRoots({
        projectId: project.projectId,
        roots: await this.gateway.listRoots(project.projectId),
        conductorId: this.conductorId,
      });
      const scheduling = this.scheduling.evaluate(roots);
      for (const root of scheduling.orderedEligible) {
        const candidate = await this.gateway.reconstructV3(root.issueId);
        if (this.harness.assessRoot(candidate).readiness !== "runnable") continue;
        if (!candidate.managedComment) {
          const claimed = await this.harness.claimRoot(candidate);
          if (claimed.kind !== "ready") {
            await this.reporter.report({ status: "blocked", rootId: root.issueId,
              sanitizedReason: claimed.reason });
            return;
          }
        }
        const result = await this.harness.runRootTurn(root.issueId);
        await this.reporter.report({
          status: result.kind === "failed" ? "blocked" : "ready",
          rootId: root.issueId,
          ...(result.kind === "failed"
            ? { sanitizedReason: result.sanitizedFailure }
            : {}),
        });
        return;
      }
      await this.reporter.report({ status: "ready" });
    } catch (error) {
      await this.reporter.report({
        status: "blocked", sanitizedReason: sanitize(error),
      });
    }
  }
}


function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 2048);
}
