import { parseCorrelationId, type RootIssueId } from "../contracts/identity.js";
import type { LinearObservation } from "../contracts/observation.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import type { RootHomeManager } from "../root-reconcill/internal/RootHome.js";
import type { StructuredLoggerInterface } from "../runtime-logs/StructuredLogger.js";

interface RetirableRuntimeRegistry {
  has(rootId: RootIssueId): boolean;
  close(rootId: RootIssueId): Promise<void>;
}

export type RootRetirementState = "idle" | "retiring" | "stopped";

export type RootRetirementResult =
  | { readonly kind: "retired"; readonly observation: LinearObservation }
  | { readonly kind: "retained_in_review" | "not_done"; readonly observation: LinearObservation };

export class RootRetirement {
  #state: RootRetirementState = "idle";
  #sequence = 0;

  constructor(
    private readonly linear: LinearGatewayInterface,
    private readonly runtimes: RetirableRuntimeRegistry,
    private readonly homes: RootHomeManager,
    private readonly logger: StructuredLoggerInterface,
  ) {}

  get state(): RootRetirementState { return this.#state; }

  async retireIfDone(rootId: RootIssueId): Promise<RootRetirementResult> {
    if (this.#state !== "idle") throw new Error("root_retirement_not_idle");
    this.#state = "retiring";
    const correlationId = parseCorrelationId(`retirement:${++this.#sequence}`);
    try {
      this.logger.publish({ event: "root_retirement_started", correlation_id: correlationId, root_id: rootId });
      const observation = await this.linear.readRoot(rootId);
      if (observation.root_id !== rootId) throw new Error("root_retirement_identity_mismatch");
      if (observation.root_status !== "Done") {
        const kind = observation.root_status === "In Review" ? "retained_in_review" : "not_done";
        this.logger.publish({
          event: "root_retirement_retained",
          correlation_id: correlationId,
          root_id: rootId,
          root_status: observation.root_status,
        });
        this.#state = "idle";
        return Object.freeze({ kind, observation });
      }
      if (!this.runtimes.has(rootId)) throw new Error("root_runtime_not_found");
      await this.runtimes.close(rootId);
      await this.homes.delete(rootId, (candidate) => this.runtimes.has(candidate));
      this.logger.publish({ event: "root_retirement_completed", correlation_id: correlationId, root_id: rootId });
      this.#state = "idle";
      return Object.freeze({ kind: "retired", observation });
    } catch (error) {
      this.#state = "stopped";
      try {
        this.logger.publish({
          event: "root_retirement_failed",
          correlation_id: correlationId,
          root_id: rootId,
          reason_code: "retirement_failed",
        });
      } catch {
        throw new Error("root_retirement_failure_logging_failed");
      }
      throw error;
    }
  }
}
