import { randomUUID } from "node:crypto";

import {
  parseCorrelationId,
  parseRootIssueId,
  type CorrelationId,
  type RootIssueId,
  type TaskDigest,
} from "../../contracts/identity.js";
import {
  parseTaskObservationEvent,
  type TaskObservationEvent,
  type TaskChangeOriginEvidence,
} from "../../contracts/observation.js";
import type { TaskSnapshot } from "../../contracts/task-management.js";
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
  readLatestIssueChangeOrigin(issueId: TaskSnapshot["issues"][number]["issue_id"]): Promise<TaskChangeOriginEvidence | null>;
}

interface PollingBaseline {
  readonly digest: TaskDigest;
  readonly snapshot: TaskSnapshot;
}

export interface LinearObserverOptions {
  readonly root_id: RootIssueId;
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
  readonly #rootId: RootIssueId;
  #baseline: PollingBaseline | undefined;
  readonly #identityFactory: () => string;
  readonly #now: () => Date;

  constructor(
    private readonly queries: LinearObserverQueries,
    private readonly options: LinearObserverOptions,
  ) {
    this.#rootId = parseRootIssueId(options.root_id);
    this.#identityFactory = options.identity_factory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
  }

  async poll_once(): Promise<readonly TaskObservationEvent[]> {
    const correlationId = parseCorrelationId(this.#identityFactory());
    const observedAt = this.#now().toISOString();
    let failures = 0;
    try {
      await this.queries.inventoryRoots();
    } catch (error) {
      failures += 1;
      this.options.log(Object.freeze({
        event: "task_observation_inventory_failed",
        correlation_id: correlationId,
        reason_code: failureReason(error, "inventory"),
      }));
    }

    const events: TaskObservationEvent[] = [];
    try {
      const current = await this.queries.readRootSnapshot(this.#rootId);
      const digest = taskSnapshotDigest(current);
      const previous = this.#baseline;
      const taskChangeOrigins = (await Promise.all(current.issues.map(
        ({ issue_id }) => this.queries.readLatestIssueChangeOrigin(issue_id),
      ))).filter((entry): entry is TaskChangeOriginEvidence => entry !== null)
        .sort((left, right) => left.issue_id.localeCompare(right.issue_id));
      const event = parseTaskObservationEvent({
        schema_version: 1,
        root_id: this.#rootId,
        correlation_id: correlationId,
        observed_at: observedAt,
        from_task_digest: previous?.digest ?? null,
        to_task_digest: digest,
        task: current,
        task_changes: previous === undefined || previous.digest === digest
          ? []
          : taskSnapshotChanges(previous.snapshot, current),
        task_change_origins: taskChangeOrigins,
      });
      this.#baseline = Object.freeze({ digest, snapshot: current });
      events.push(event);
    } catch (error) {
      failures += 1;
      this.options.log(Object.freeze({
        event: "task_observation_root_failed",
        correlation_id: correlationId,
        root_id: this.#rootId,
        reason_code: failureReason(error, "root"),
      }));
    }
    this.options.log(Object.freeze({
      event: "task_observation_poll_completed",
      correlation_id: correlationId,
      roots_polled: 1,
      events_emitted: events.length,
      failures,
    }));
    return Object.freeze(events);
  }
}
