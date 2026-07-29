import { parseCorrelationId } from "../contracts/identity.js";
import type { DeliveryInterface } from "../delivery/api/DeliveryInterface.js";
import type { GitWorkspaceInterface } from "../git/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { StagePerformerInterface } from "../performer/api/StagePerformerInterface.js";
import type { RootReconcillFactoryInterface } from "../root-reconcill/api/RootReconcillInterface.js";
import type { StructuredLoggerInterface } from "../runtime-logs/StructuredLogger.js";

export interface RuntimeDependencies {
  readonly linear: LinearGatewayInterface;
  readonly rootReconcillFactory: RootReconcillFactoryInterface;
  readonly performer: StagePerformerInterface;
  readonly git: GitWorkspaceInterface;
  readonly delivery: DeliveryInterface;
  readonly logger: StructuredLoggerInterface;
}

export type SerialRuntimeState = "idle" | "discovering" | "stopped";

export class SerialRuntimeShell {
  #state: SerialRuntimeState = "idle";
  #sequence = 0;

  constructor(private readonly dependencies: RuntimeDependencies) {}

  get state(): SerialRuntimeState { return this.#state; }

  async tick(): Promise<void> {
    if (this.#state !== "idle") throw new Error("runtime_not_idle");
    this.#state = "discovering";
    const correlationId = parseCorrelationId(`discovery:${++this.#sequence}`);
    this.dependencies.logger.publish({ event: "discovery_started", correlation_id: correlationId });
    try {
      const roots = await this.dependencies.linear.discoverRoots();
      this.dependencies.logger.publish({
        event: "discovery_completed",
        correlation_id: correlationId,
        root_count: roots.length,
      });
      const root = roots[0];
      if (root) {
        this.#state = "stopped";
        this.dependencies.logger.publish({
          event: "root_execution_stopped",
          correlation_id: correlationId,
          root_id: root.root_id,
          reason_code: "root_execution_not_implemented",
        });
        throw new Error("root_execution_not_implemented");
      }
      this.#state = "idle";
    } catch (error) {
      if (this.#state !== "stopped") this.#state = "stopped";
      throw error;
    }
  }
}
