import { discoverCurrentRoots } from "../root-discovery/MultiRootDiscoveryPolicy.js";
import type { AgentSymphonyHarnessInterface } from "../agent-symphony-harness/api/AgentSymphonyHarnessInterface.js";
import type { RootSchedulingPolicyInterface } from "../root-scheduling/api/RootSchedulingPolicyInterface.js";
import {
  computeRootAction,
  type DiscoveredRoot,
  type RootAction,
  type RootRunView,
  type V3RootRunView,
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

export interface V3RuntimeGateway {
  resolveProject(): ReturnType<RuntimeGateway["resolveProject"]>;
  listRoots(projectId: string): Promise<DiscoveredRoot[]>;
  reconstructV3(rootId: string): Promise<V3RootRunView>;
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
      let blockedCandidate: {
        view: RootRunView;
        action: Extract<RootAction, { kind: "blocked_root" }>;
      } | undefined;
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
        const action = computeRootAction(view);
        if (isRunnable(action)) {
          await this.executor.execute(view, action);
          await this.reporter.report({
            status: "ready",
            rootId: view.root.issueId,
          });
          return;
        }
        if (!blockedCandidate && action.kind === "blocked_root") {
          blockedCandidate = { view, action };
        }
      }
      if (blockedCandidate) {
        await this.reporter.report({
          status: "blocked",
          sanitizedReason: blockedCandidate.action.reason,
          rootId: blockedCandidate.view.root.issueId,
        });
      } else if (scheduling.blocked.length === 0) {
        await this.reporter.report({ status: "ready" });
      }
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
