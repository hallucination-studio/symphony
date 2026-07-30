import type { BoundaryErrorCode } from "../contracts/common-outcomes.js";
import {
  parseTaskIssueId,
  type CorrelationId,
  type RootIssueId,
  type RuntimeGeneration,
} from "../contracts/identity.js";
import {
  parseTaskObservationEvent,
  type TaskIssueSnapshot,
  type TaskObservationEvent,
} from "../contracts/observation.js";
import type { RootTurnOutcome } from "../contracts/runtime.js";
import { parseBoundedString } from "../contracts/validation.js";
import type { RootRuntimeRegistry } from "./RootRuntimeRegistry.js";

type AdmissionParkReason =
  | "in_review"
  | "invalid_root_kind"
  | "not_delegated"
  | "runtime_stopped"
  | "status_not_executable";

type RuntimeFailureReason = "runtime_preparation_failed" | "turn_boundary_failed";

export type SerialConductorLog =
  | {
    readonly event: "root_observation_buffered";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly replaced: boolean;
  }
  | {
    readonly event: "root_admission_parked";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly reason_code: AdmissionParkReason;
  }
  | {
    readonly event: "root_observation_paused";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly reason_code: BoundaryErrorCode;
  }
  | {
    readonly event: "root_observation_unchanged";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
  }
  | {
    readonly event: "root_observation_failed";
    readonly root_id: RootIssueId;
    readonly correlation_id: CorrelationId;
    readonly reason_code: "runtime_preparation_failed";
  }
  | {
    readonly event: "root_turn_started";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly input_kind: "bootstrap" | "diff";
  }
  | {
    readonly event: "root_turn_completed";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly outcome: RootTurnOutcome["outcome"];
  }
  | {
    readonly event: "root_turn_failed";
    readonly root_id: RootIssueId;
    readonly runtime_generation: RuntimeGeneration;
    readonly correlation_id: CorrelationId;
    readonly reason_code: "turn_boundary_failed";
  };

export type SerialRunResult =
  | { readonly kind: "idle" }
  | {
    readonly kind: "turn_completed";
    readonly root_id: RootIssueId;
    readonly outcome: RootTurnOutcome["outcome"];
  }
  | {
    readonly kind: "paused";
    readonly root_id: RootIssueId;
    readonly reason_code: BoundaryErrorCode;
  }
  | {
    readonly kind: "failed";
    readonly root_id: RootIssueId;
    readonly reason_code: RuntimeFailureReason;
  };

export interface SerialConductorOptions {
  readonly agent_actor_id: string;
  readonly log: (entry: SerialConductorLog) => void;
}

function rootIssue(observation: TaskObservationEvent): TaskIssueSnapshot {
  const rootTaskId = parseTaskIssueId(observation.root_id);
  const issue = observation.task.issues.find(({ issue_id }) => issue_id === rootTaskId);
  if (issue === undefined) throw new Error("missing_root_identity");
  return issue;
}

function admissionReason(
  observation: TaskObservationEvent,
  actorId: string,
  stopped: boolean,
): AdmissionParkReason | null {
  if (stopped) return "runtime_stopped";
  const issue = rootIssue(observation);
  if (!issue.labels.includes("symphony:kind/root")) return "invalid_root_kind";
  if (issue.delegate_id !== actorId) return "not_delegated";
  if (issue.status === "In Review") return "in_review";
  if (issue.status !== "Todo" && issue.status !== "In Progress") return "status_not_executable";
  return null;
}

export class SerialConductor {
  readonly #actorId: string;
  readonly #pending = new Map<RootIssueId, TaskObservationEvent>();
  readonly #stopped = new Set<RootIssueId>();
  #busy = false;

  constructor(
    private readonly registry: RootRuntimeRegistry,
    private readonly options: SerialConductorOptions,
  ) {
    this.#actorId = parseBoundedString(options.agent_actor_id, "invalid_agent_actor_id", 256);
  }

  admit(inputs: readonly unknown[]): void {
    const observations = inputs.map(parseTaskObservationEvent);
    for (const observation of observations) {
      const replaced = this.#pending.has(observation.root_id);
      this.#pending.set(observation.root_id, observation);
      this.options.log(Object.freeze({
        event: "root_observation_buffered",
        root_id: observation.root_id,
        correlation_id: observation.correlation_id,
        replaced,
      }));
    }
  }

  async runNext(): Promise<SerialRunResult> {
    if (this.#busy) throw new Error("serial_conductor_busy");
    this.#busy = true;
    try {
      return await this.#runNext();
    } finally {
      this.#busy = false;
    }
  }

  async #runNext(): Promise<SerialRunResult> {
    const observations = [...this.#pending.values()]
      .sort((left, right) => left.root_id.localeCompare(right.root_id));
    for (const observation of observations) {
      if (this.#pending.get(observation.root_id) !== observation) continue;
      const parkReason = admissionReason(
        observation,
        this.#actorId,
        this.#stopped.has(observation.root_id),
      );
      if (parkReason !== null) {
        this.#pending.delete(observation.root_id);
        this.options.log(Object.freeze({
          event: "root_admission_parked",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
          reason_code: parkReason,
        }));
        continue;
      }

      this.#pending.delete(observation.root_id);
      let runtime;
      let attempt;
      try {
        runtime = await this.registry.getOrCreate(observation.root_id);
        attempt = await runtime.prepare(observation);
      } catch {
        this.#stopped.add(observation.root_id);
        this.options.log(Object.freeze({
          event: "root_observation_failed",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
          reason_code: "runtime_preparation_failed",
        }));
        return Object.freeze({
          kind: "failed",
          root_id: observation.root_id,
          reason_code: "runtime_preparation_failed",
        });
      }

      if (attempt.kind === "paused") {
        this.options.log(Object.freeze({
          event: "root_observation_paused",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
          reason_code: attempt.error.code,
        }));
        return Object.freeze({
          kind: "paused",
          root_id: observation.root_id,
          reason_code: attempt.error.code,
        });
      }
      if (attempt.kind === "unchanged") {
        this.options.log(Object.freeze({
          event: "root_observation_unchanged",
          root_id: observation.root_id,
          correlation_id: observation.correlation_id,
        }));
        continue;
      }

      this.options.log(Object.freeze({
        event: "root_turn_started",
        root_id: observation.root_id,
        runtime_generation: runtime.target.runtime_generation,
        correlation_id: observation.correlation_id,
        input_kind: attempt.kind,
      }));
      let outcome: RootTurnOutcome;
      try {
        outcome = await runtime.run(attempt);
      } catch {
        this.#stopped.add(observation.root_id);
        this.options.log(Object.freeze({
          event: "root_turn_failed",
          root_id: observation.root_id,
          runtime_generation: runtime.target.runtime_generation,
          correlation_id: observation.correlation_id,
          reason_code: "turn_boundary_failed",
        }));
        return Object.freeze({
          kind: "failed",
          root_id: observation.root_id,
          reason_code: "turn_boundary_failed",
        });
      }

      if (outcome.outcome === "quiescent" || outcome.outcome === "stopped") runtime.accept(attempt);
      if (outcome.outcome !== "quiescent") this.#stopped.add(observation.root_id);
      this.options.log(Object.freeze({
        event: "root_turn_completed",
        root_id: observation.root_id,
        runtime_generation: runtime.target.runtime_generation,
        correlation_id: observation.correlation_id,
        outcome: outcome.outcome,
      }));
      return Object.freeze({
        kind: "turn_completed",
        root_id: observation.root_id,
        outcome: outcome.outcome,
      });
    }
    return Object.freeze({ kind: "idle" });
  }
}
