import { discoverCurrentRoots } from "../root-discovery/MultiRootDiscoveryPolicy.js";
import {
  computeRootAction,
  type DiscoveredRoot,
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
      const owned = roots.filter(
        ({ managedConductorId }) => managedConductorId === this.conductorId,
      );
      let selected: DiscoveredRoot | undefined;
      if (owned.length === 1) {
        selected = owned[0];
      } else if (roots.length === 1) {
        selected = roots[0];
      }
      if (!selected) {
        let reason: "multiple_active_roots" | "no_eligible_root" | "multiple_eligible_roots";
        if (owned.length > 1) {
          reason = "multiple_active_roots";
        } else if (roots.length === 0) {
          reason = "no_eligible_root";
        } else {
          reason = "multiple_eligible_roots";
        }
        await this.reporter.report({
          status: reason === "no_eligible_root" ? "ready" : "blocked",
          ...(reason === "no_eligible_root"
            ? {}
            : { sanitizedReason: reason }),
        });
        return;
      }
      const view = await this.gateway.reconstruct(selected.issueId);
      const action = computeRootAction(view);
      await this.executor.execute(view, action);
      await this.reporter.report({
        status: action.kind === "blocked_root" ? "blocked" : "ready",
        ...(action.kind === "blocked_root"
          ? { sanitizedReason: action.reason }
          : {}),
        rootId: view.root.issueId,
      });
    } catch (error) {
      await this.reporter.report({
        status: "blocked",
        sanitizedReason: sanitize(error),
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
