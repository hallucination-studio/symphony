import { createHash, randomUUID } from "node:crypto";

import {
  parseCorrelationId,
  parseTaskDigest,
  type CorrelationId,
  type RootIssueId,
  type TaskDigest,
} from "../../contracts/identity.js";
import {
  parseTaskObservationEvent,
  type ConcreteTaskChange,
  type TaskObservationEvent,
  type TaskRelationSnapshot,
  type TaskSnapshot,
} from "../../contracts/observation.js";
import type { TaskManageObserverInterface } from "../api/TaskManageObserverInterface.js";
import { linearIssueDiff } from "./LinearTaskChanges.js";

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

function taskDigest(snapshot: TaskSnapshot): TaskDigest {
  const canonical = {
    root_id: snapshot.root_id,
    issues: [...snapshot.issues]
      .sort((left, right) => left.issue_id.localeCompare(right.issue_id))
      .map((issue) => ({
        issue_id: issue.issue_id,
        revision: issue.revision,
        status: issue.status,
        title: issue.title,
        description: issue.description,
        parent_id: issue.parent_id,
        labels: [...issue.labels].sort(),
        delegate_id: issue.delegate_id,
        priority: issue.priority,
      })),
    relations: [...snapshot.relations]
      .sort((left, right) => left.relation_id.localeCompare(right.relation_id))
      .map((relation) => ({
        relation_id: relation.relation_id,
        revision: relation.revision,
        type: relation.type,
        source_issue_id: relation.source_issue_id,
        target_issue_id: relation.target_issue_id,
      })),
  };
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return parseTaskDigest(`sha256:${digest}`);
}

function sameRelation(left: TaskRelationSnapshot, right: TaskRelationSnapshot): boolean {
  return left.type === right.type
    && left.source_issue_id === right.source_issue_id
    && left.target_issue_id === right.target_issue_id;
}

function taskChanges(before: TaskSnapshot, after: TaskSnapshot): readonly ConcreteTaskChange[] {
  const changes: ConcreteTaskChange[] = [];
  const beforeIssues = new Map(before.issues.map((issue) => [issue.issue_id, issue]));
  const afterIssues = new Map(after.issues.map((issue) => [issue.issue_id, issue]));
  const issueIds = new Set([...beforeIssues.keys(), ...afterIssues.keys()]);
  for (const issueId of [...issueIds].sort()) {
    const previous = beforeIssues.get(issueId);
    const current = afterIssues.get(issueId);
    if (previous === undefined && current !== undefined) changes.push({ kind: "issue_created", issue: current });
    else if (previous !== undefined && current === undefined) changes.push({ kind: "issue_archived", issue: previous });
    else if (previous !== undefined && current !== undefined) changes.push(...linearIssueDiff(previous, current));
  }

  const beforeRelations = new Map(before.relations.map((relation) => [relation.relation_id, relation]));
  const afterRelations = new Map(after.relations.map((relation) => [relation.relation_id, relation]));
  const relationIds = new Set([...beforeRelations.keys(), ...afterRelations.keys()]);
  for (const relationId of [...relationIds].sort()) {
    const previous = beforeRelations.get(relationId);
    const current = afterRelations.get(relationId);
    if (previous === undefined && current !== undefined) changes.push({ kind: "relation_added", relation: current });
    else if (previous !== undefined && current === undefined) changes.push({ kind: "relation_removed", relation: previous });
    else if (previous !== undefined && current !== undefined && !sameRelation(previous, current)) {
      changes.push(
        { kind: "relation_removed", relation: previous },
        { kind: "relation_added", relation: current },
      );
    }
  }
  return Object.freeze(changes);
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
        const digest = taskDigest(current);
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
          task_changes: previous === undefined ? [] : taskChanges(previous.snapshot, current),
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
