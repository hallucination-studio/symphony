import { discoverCurrentRoots } from "../root-discovery/MultiRootDiscoveryPolicy.js";
import type { RootSchedulingPolicyInterface } from "../root-scheduling/api/RootSchedulingPolicyInterface.js";
import {
  computeRootAction,
  type DiscoveredRoot,
  type RootAction,
  type RootRunView,
} from "../root-workflow/api/index.js";

export interface RuntimeGateway {
  resolveProject(): Promise<
    | { kind: "resolved"; projectId: string }
    | { kind: "unbound" | "ambiguous" | "label_conflict" }
  >;
  listRoots(projectId: string): Promise<
    DiscoveredRoot[]
  >;
  reconstruct(rootId: string): Promise<RootRunView>;
}

export interface RuntimeActionExecutor {
  execute(view: RootRunView, action: ReturnType<typeof computeRootAction>): Promise<void>;
}

export interface RuntimeReporter {
  report(input: {
    status: "ready" | "blocked";
    sanitizedReason?: string;
    rootId?: string;
  }): Promise<void>;
}

export class ConductorRuntime {
  constructor(
    private readonly conductorId: string,
    private readonly gateway: RuntimeGateway,
    private readonly scheduling: RootSchedulingPolicyInterface,
    private readonly executor: RuntimeActionExecutor,
    private readonly reporter: RuntimeReporter,
  ) {}

  async cycle() {
    try {
      const project = await this.gateway.resolveProject();
      if (project.kind !== "resolved") {
        await this.reporter.report({
          status: "blocked",
          sanitizedReason: `project_${project.kind}`,
        });
        return;
      }
      const roots = discoverCurrentRoots({
        projectId: project.projectId,
        roots: await this.gateway.listRoots(project.projectId),
        conductorId: this.conductorId,
      });
      const candidates: Array<{
        view: RootRunView;
        action: RootAction;
      }> = [];
      const scheduling = this.scheduling.evaluate(roots);
      for (const blocked of scheduling.blocked) {
        await this.reporter.report({
          status: "blocked",
          sanitizedReason: blocked.reason,
          rootId: blocked.root.issueId,
        });
      }
      for (const root of scheduling.orderedEligible) {
        const view = await this.gateway.reconstruct(root.issueId);
        candidates.push({ view, action: computeRootAction(view) });
      }
      const selected = candidates.find(({ action }) => isRunnable(action));
      if (!selected) {
        const blocked = candidates.find(
          ({ action }) => action.kind === "blocked_root",
        );
        if (blocked?.action.kind === "blocked_root") {
          await this.reporter.report({
            status: "blocked",
            sanitizedReason: blocked.action.reason,
            rootId: blocked.view.root.issueId,
          });
        } else if (scheduling.blocked.length === 0) {
          await this.reporter.report({ status: "ready" });
        }
        return;
      }
      await this.executor.execute(selected.view, selected.action);
      await this.reporter.report({
        status: "ready",
        rootId: selected.view.root.issueId,
      });
    } catch (error) {
      await this.reporter.report({
        status: "blocked",
        sanitizedReason: sanitize(error),
      });
    }
  }
}

function isRunnable(action: RootAction): boolean {
  return (
    action.kind !== "wait_human" &&
    action.kind !== "idle_root" &&
    action.kind !== "blocked_root"
  );
}

function sanitize(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .slice(0, 2048);
}
