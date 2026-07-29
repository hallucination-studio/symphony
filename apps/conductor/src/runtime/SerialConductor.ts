import { parseCorrelationId, type RootIssueId } from "../contracts/identity.js";
import type { LinearObservation } from "../contracts/observation.js";
import type { LinearGatewayInterface } from "../linear/api/LinearGatewayInterface.js";
import { RootDiscovery, type RootAdmission } from "../orchestration/RootDiscovery.js";
import type { StructuredLoggerInterface } from "../runtime-logs/StructuredLogger.js";

interface SerialRootAdvancer {
  advance(admission: RootAdmission): Promise<LinearObservation>;
}

export type SerialConductorState = "idle" | "advancing" | "stopped";

export type SerialTickResult =
  | { readonly kind: "idle" }
  | {
    readonly kind: "advanced" | "suspended_in_review";
    readonly root_id: RootIssueId;
    readonly observation: LinearObservation;
  };

export class SerialConductor {
  readonly #discovery: RootDiscovery;
  #state: SerialConductorState = "idle";
  #activeRootId: RootIssueId | null = null;
  #sequence = 0;

  constructor(
    linear: LinearGatewayInterface,
    private readonly advancer: SerialRootAdvancer,
    private readonly logger: StructuredLoggerInterface,
  ) {
    this.#discovery = new RootDiscovery(linear);
  }

  get state(): SerialConductorState { return this.#state; }
  get active_root_id(): RootIssueId | null { return this.#activeRootId; }

  async tick(): Promise<SerialTickResult> {
    if (this.#state === "advancing") throw new Error("serial_conductor_busy");
    if (this.#state !== "idle") throw new Error("serial_conductor_not_idle");
    this.#state = "advancing";
    const correlationId = parseCorrelationId(`serial:${++this.#sequence}`);
    try {
      this.logger.publish({ event: "discovery_started", correlation_id: correlationId });
      const admission = await this.#discovery.nextExecutable();
      this.logger.publish({
        event: "discovery_completed",
        correlation_id: correlationId,
        selected_root_id: admission?.candidate.root_id ?? null,
      });
      if (!admission) {
        this.#state = "idle";
        return Object.freeze({ kind: "idle" });
      }
      this.#activeRootId = admission.candidate.root_id;
      this.logger.publish({
        event: "root_advance_started",
        correlation_id: correlationId,
        root_id: this.#activeRootId,
      });
      const observation = await this.advancer.advance(admission);
      if (observation.root_id !== this.#activeRootId) throw new Error("serial_advance_identity_mismatch");
      this.logger.publish({
        event: "root_advance_completed",
        correlation_id: correlationId,
        root_id: observation.root_id,
        root_status: observation.root_status,
      });
      const kind = observation.root_status === "In Review" ? "suspended_in_review" : "advanced";
      this.#activeRootId = null;
      this.#state = "idle";
      return Object.freeze({ kind, root_id: observation.root_id, observation });
    } catch (error) {
      const failedRootId = this.#activeRootId;
      this.#activeRootId = null;
      this.#state = "stopped";
      this.logger.publish({
        event: "serial_tick_failed",
        correlation_id: correlationId,
        root_id: failedRootId,
        reason_code: "tick_failed",
      });
      throw error;
    }
  }
}
