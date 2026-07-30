import { randomUUID } from "node:crypto";

import {
  parseCorrelationId,
  type CorrelationId,
  type RootIssueId,
  type TaskDigest,
} from "../../contracts/identity.js";
import {
  parseTaskObservationEvent,
  type TaskObservationEvent,
  type TaskSnapshot,
} from "../../contracts/observation.js";
import { taskSnapshotChanges, taskSnapshotDigest } from "../../observation/TaskFacts.js";
import type { TaskManageObserverInterface } from "../api/TaskManageObserverInterface.js";

type FailureReason = "boundary_unavailable" | "invalid_inventory" | "invalid_root_tree";

export type TaskObservationLog =
  | {
    readonly event: "task_observation_poll_completed";
    readonly correlation_id: CorrelationId;
    readonly roots_polled: number;
    readonly events_emitted: number;
    readonly failures: number;
  }
  | {
    readonly event: "task_observation_inventory_failed";
    readonly correlation_id: CorrelationId;
    readonly reason_code: FailureReason;
  }
  | {
    readonly event: "task_observation_root_failed";
    readonly correlation_id: CorrelationId;
    readonly root_id: RootIssueId;
    readonly reason_code: FailureReason;
  };

interface LinearObserverQueries {
  inventoryRoots(): Promise<readonly { readonly root_id: RootIssueId }[]>;
  readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot>;
}

interface PollingBaseline {
  readonly digest: TaskDigest;
  readonly snapshot: TaskSnapshot;
}

export interface LinearObserverOptions {
  readonly log: (entry: TaskObservationLog) => void;
  readonly identity_factory?: () => string;
  readonly now?: () => Date;
}

function failureReason(error: unknown, phase: "inventory" | "root"): FailureReason {
  if (error instanceof Error && error.message !== "linear_boundary_unavailable" && error.message.startsWith("linear_")) {
    return phase === "inventory" ? "invalid_inventory" : "invalid_root_tree";
  }
  return "boundary_unavailable";
}

export class LinearObserver implements TaskManageObserverInterface {
  readonly #baselines = new Map<RootIssueId, PollingBaseline>();
  readonly #identityFactory: () => string;
  readonly #now: () => Date;

  constructor(
    private readonly queries: LinearObserverQueries,
    private readonly options: LinearObserverOptions,
  ) {
    this.#identityFactory = options.identity_factory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async poll_once(): Promise<readonly TaskObservationEvent[]> {
    const correlationId = parseCorrelationId(this.#identityFactory());
    const observedAt = this.#now().toISOString();
    const rootIds = new Set(this.#baselines.keys());
    let failures = 0;
    try {
      for (const root of await this.queries.inventoryRoots()) rootIds.add(root.root_id);
    } catch (error) {
      failures += 1;
      this.options.log(Object.freeze({
        event: "task_observation_inventory_failed",
        correlation_id: correlationId,
        reason_code: failureReason(error, "inventory"),
      }));
    }

    const events: TaskObservationEvent[] = [];
    for (const rootId of [...rootIds].sort()) {
      try {
        const current = await this.queries.readRootSnapshot(rootId);
        const digest = taskSnapshotDigest(current);
        const previous = this.#baselines.get(rootId);
        if (previous?.digest === digest) {
          this.#baselines.set(rootId, Object.freeze({ digest, snapshot: current }));
          continue;
        }
        const event = parseTaskObservationEvent({
          schema_version: 1,
          root_id: rootId,
          correlation_id: correlationId,
          observed_at: observedAt,
          from_task_digest: previous?.digest ?? null,
          to_task_digest: digest,
          task: current,
          task_changes: previous === undefined ? [] : taskSnapshotChanges(previous.snapshot, current),
        });
        this.#baselines.set(rootId, Object.freeze({ digest, snapshot: current }));
        events.push(event);
      } catch (error) {
        failures += 1;
        this.options.log(Object.freeze({
          event: "task_observation_root_failed",
          correlation_id: correlationId,
          root_id: rootId,
          reason_code: failureReason(error, "root"),
        }));
      }
    }
    this.options.log(Object.freeze({
      event: "task_observation_poll_completed",
      correlation_id: correlationId,
      roots_polled: rootIds.size,
      events_emitted: events.length,
      failures,
    }));
    return Object.freeze(events);
  }
}
