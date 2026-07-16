import { discoverV1Root } from "../root-discovery/SingleRootDiscoveryPolicy.js";
import {
  computeRootAction,
  type RootRunView,
} from "../root-workflow/api/index.js";

export interface RuntimeGateway {
  resolveProject(): Promise<
    | { kind: "resolved"; projectId: string }
    | { kind: "unbound" | "ambiguous" | "label_conflict" }
  >;
  listRoots(projectId: string): Promise<
    Array<
      RootRunView["root"] & {
        projectId: string;
        parentIssueId: string | null;
        isDelegatedToSymphony: boolean;
        managedConductorId?: string;
      }
    >
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
      const roots = await this.gateway.listRoots(project.projectId);
      const selection = discoverV1Root({
        project,
        roots,
        conductorId: this.conductorId,
      });
      if (selection.kind === "conductor_wait") {
        await this.reporter.report({
          status: selection.reason === "no_eligible_root" ? "ready" : "blocked",
          ...(selection.reason === "no_eligible_root"
            ? {}
            : { sanitizedReason: selection.reason }),
        });
        return;
      }
      const view = await this.gateway.reconstruct(selection.rootId);
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
