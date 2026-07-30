import {
  parseRootIssueId,
  parseTaskIssueId,
  parseTaskLabelId,
  parseTaskRevision,
  parseTaskStateId,
  type RootIssueId,
  type TaskIssueId,
  type TaskRevision,
} from "../../contracts/identity.js";
import {
  parseTaskIssueSnapshot,
  parseTaskRelationSnapshot,
  parseTaskSnapshot,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
  type TaskSnapshot,
} from "../../contracts/observation.js";
import { asRecord, assertExactKeys, parseArray, parseBoundedString, parseEnum } from "../../contracts/validation.js";
import type {
  GetIssueCall,
  GetIssueResult,
  ListChildrenCall,
  ListChildrenResult,
  ListIssuesCall,
  ListIssuesResult,
  ListLabelsCall,
  ListLabelsResult,
  ListRelationsCall,
  ListRelationsResult,
  ListStatesCall,
  ListStatesResult,
  TaskLabelResource,
  TaskStateResource,
} from "../mcp/TaskMcpSchemas.js";

const INTERNAL_PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 5_000;
const KIND_PREFIX = "symphony:kind/";
const ROOT_STATUSES = ["Todo", "In Progress", "In Review", "Done"] as const;
const CYCLE_STATUSES = ["Planning", "Executing", "Verifying", "Succeeded", "Canceled"] as const;
const ACTIVE_CYCLE_STATUSES = new Set(["Planning", "Executing", "Verifying"]);
const STAGE_KINDS = ["plan", "work", "verify"] as const;
const STAGE_STATUSES = ["Todo", "In Progress", "Done", "Failed", "Canceled"] as const;

export interface LinearQueryClient {
  getIssue(issueId: string): Promise<unknown>;
  listIssues(teamId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listChildren(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listRelations(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listStates(teamId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listLabels(teamId: string, cursor: string | null, pageSize: number): Promise<unknown>;
}

export interface LinearQueryOptions {
  readonly team_id: string;
  readonly delegate_actor_id: string;
}

export interface RootInventoryItem {
  readonly root_id: RootIssueId;
  readonly revision: TaskRevision;
  readonly status: typeof ROOT_STATUSES[number];
  readonly priority: number;
  readonly created_at: string;
}

interface LinearIssueRecord {
  readonly snapshot: TaskIssueSnapshot;
  readonly teamId: string;
  readonly createdAt: string;
}

interface Page<T> {
  readonly nodes: readonly T[];
  readonly nextCursor: string | null;
}

type StateRecord = TaskStateResource & { readonly team_id: string };
type LabelRecord = TaskLabelResource & { readonly team_id: string | null };

class LinearQueryError extends Error {}

function fail(code: string): never {
  throw new LinearQueryError(code);
}

function providerPayload<T>(parser: () => T): T {
  try {
    return parser();
  } catch (error) {
    if (error instanceof LinearQueryError) throw error;
    return fail("linear_invalid_payload");
  }
}

function parseNullableText(value: unknown, code: string, max: number): string | null {
  return value === null ? null : parseBoundedString(value, code, max);
}

function parsePriority(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4) {
    return fail("linear_invalid_payload");
  }
  return value as number;
}

function parseTimestamp(value: unknown): string {
  const timestamp = parseBoundedString(value, "invalid_linear_timestamp", 64);
  if (Number.isNaN(Date.parse(timestamp))) return fail("linear_invalid_payload");
  return new Date(timestamp).toISOString();
}

function parseIssue(value: unknown): LinearIssueRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, [
      "id", "revision", "team_id", "parent_id", "status", "title", "description", "labels",
      "delegate_id", "priority", "created_at",
    ]);
    const labels = parseArray(record.labels, (label) => parseBoundedString(label, "invalid_linear_label", 256), 256);
    return Object.freeze({
      snapshot: parseTaskIssueSnapshot({
        issue_id: record.id,
        revision: record.revision,
        status: record.status,
        title: record.title,
        description: record.description,
        parent_id: record.parent_id,
        labels,
        delegate_id: record.delegate_id,
        priority: parsePriority(record.priority),
      }),
      teamId: parseBoundedString(record.team_id, "invalid_linear_team_id", 128),
      createdAt: parseTimestamp(record.created_at),
    });
  });
}

function parseRelation(value: unknown): TaskRelationSnapshot {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, ["id", "revision", "type", "source_issue_id", "target_issue_id"]);
    return parseTaskRelationSnapshot({
      relation_id: record.id,
      revision: record.revision,
      type: record.type,
      source_issue_id: record.source_issue_id,
      target_issue_id: record.target_issue_id,
    });
  });
}

function parseState(value: unknown): StateRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, ["id", "revision", "name", "team_id"]);
    return Object.freeze({
      state_id: parseTaskStateId(record.id),
      revision: parseTaskRevision(record.revision),
      name: parseBoundedString(record.name, "invalid_linear_state_name", 256),
      team_id: parseBoundedString(record.team_id, "invalid_linear_team_id", 128),
    });
  });
}

function parseLabel(value: unknown): LabelRecord {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, ["id", "revision", "name", "team_id"]);
    return Object.freeze({
      label_id: parseTaskLabelId(record.id),
      revision: parseTaskRevision(record.revision),
      name: parseBoundedString(record.name, "invalid_linear_label_name", 256),
      team_id: record.team_id === null
        ? null
        : parseBoundedString(record.team_id, "invalid_linear_team_id", 128),
    });
  });
}

function parsePage<T>(value: unknown, parser: (entry: unknown) => T, limit: number): Page<T> {
  return providerPayload(() => {
    const record = asRecord(value);
    assertExactKeys(record, ["nodes", "page_info"]);
    const nodes = parseArray(record.nodes, parser, limit);
    const pageInfo = asRecord(record.page_info);
    assertExactKeys(pageInfo, ["has_next_page", "end_cursor"]);
    if (typeof pageInfo.has_next_page !== "boolean") return fail("linear_invalid_payload");
    const endCursor = parseNullableText(pageInfo.end_cursor, "invalid_linear_cursor", 512);
    if (pageInfo.has_next_page && endCursor === null) return fail("linear_incomplete_page");
    return Object.freeze({ nodes, nextCursor: pageInfo.has_next_page ? endCursor : null });
  });
}

type QueryCall = GetIssueCall | ListIssuesCall | ListChildrenCall | ListRelationsCall | ListStatesCall | ListLabelsCall;

function resultEnvelope<C extends QueryCall>(call: C): Omit<C, "input"> {
  return {
    schema_version: call.schema_version,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
  } as Omit<C, "input">;
}

function issueKind(
  issue: LinearIssueRecord,
  labelNames: ReadonlyMap<string, string>,
): "root" | "cycle" | typeof STAGE_KINDS[number] | null {
  for (const labelId of issue.snapshot.labels) {
    if (!labelNames.has(labelId)) return fail("linear_unknown_label_identity");
  }
  const kindLabels = issue.snapshot.labels
    .map((labelId) => labelNames.get(labelId))
    .filter((name): name is string => name?.startsWith(KIND_PREFIX) === true);
  if (kindLabels.length === 0) return null;
  if (kindLabels.length !== 1) return fail("linear_ambiguous_kind");
  const kind = kindLabels[0]?.slice(KIND_PREFIX.length);
  if (kind === "root" || kind === "cycle" || STAGE_KINDS.includes(kind as typeof STAGE_KINDS[number])) {
    return kind as "root" | "cycle" | typeof STAGE_KINDS[number];
  }
  return fail("linear_invalid_kind");
}

function parseProviderEnum<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  return providerPayload(() => parseEnum(value, allowed));
}

export class LinearQueries {
  readonly #teamId: string;
  readonly #delegateActorId: string;

  constructor(private readonly client: LinearQueryClient, options: LinearQueryOptions) {
    this.#teamId = parseBoundedString(options.team_id, "invalid_linear_team_id", 128);
    this.#delegateActorId = parseBoundedString(options.delegate_actor_id, "invalid_delegate_actor_id", 128);
  }

  get_issue(call: GetIssueCall): Promise<GetIssueResult> {
    return this.#boundary(async () => {
      const issue = await this.#issue(call.input.issue_id);
      this.#assertTeam([issue]);
      return Object.freeze({
        ...resultEnvelope(call),
        output: Object.freeze({ issue: issue.snapshot }),
      });
    });
  }

  list_issues(call: ListIssuesCall): Promise<ListIssuesResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listIssues(this.#teamId, call.input.cursor, call.input.page_size),
        parseIssue,
        call.input.page_size,
      );
      this.#assertTeam(page.nodes);
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        issues: Object.freeze(page.nodes.map(({ snapshot }) => snapshot)),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_children(call: ListChildrenCall): Promise<ListChildrenResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listChildren(call.input.parent_issue_id, call.input.cursor, call.input.page_size),
        parseIssue,
        call.input.page_size,
      );
      this.#assertTeam(page.nodes);
      for (const child of page.nodes) {
        if (child.snapshot.parent_id !== call.input.parent_issue_id) fail("linear_child_parent_mismatch");
      }
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        issues: Object.freeze(page.nodes.map(({ snapshot }) => snapshot)),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_relations(call: ListRelationsCall): Promise<ListRelationsResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listRelations(call.input.issue_id, call.input.cursor, call.input.page_size),
        parseRelation,
        call.input.page_size,
      );
      for (const relation of page.nodes) {
        if (relation.source_issue_id !== call.input.issue_id && relation.target_issue_id !== call.input.issue_id) {
          fail("linear_relation_identity_mismatch");
        }
      }
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        relations: page.nodes,
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_states(call: ListStatesCall): Promise<ListStatesResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listStates(this.#teamId, call.input.cursor, call.input.page_size),
        parseState,
        call.input.page_size,
      );
      for (const state of page.nodes) if (state.team_id !== this.#teamId) fail("linear_team_mismatch");
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        states: Object.freeze(page.nodes.map((state) => Object.freeze({
          state_id: state.state_id,
          revision: state.revision,
          name: state.name,
        }))),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  list_labels(call: ListLabelsCall): Promise<ListLabelsResult> {
    return this.#boundary(async () => {
      const page = parsePage(
        await this.client.listLabels(this.#teamId, call.input.cursor, call.input.page_size),
        parseLabel,
        call.input.page_size,
      );
      for (const label of page.nodes) {
        if (label.team_id !== null && label.team_id !== this.#teamId) fail("linear_team_mismatch");
      }
      return Object.freeze({ ...resultEnvelope(call), output: Object.freeze({
        labels: Object.freeze(page.nodes.map((label) => Object.freeze({
          label_id: label.label_id,
          revision: label.revision,
          name: label.name,
        }))),
        next_cursor: page.nextCursor,
      }) });
    });
  }

  inventoryRoots(): Promise<readonly RootInventoryItem[]> {
    return this.#boundary(async () => {
      const issues = await this.#all(
        (cursor) => this.client.listIssues(this.#teamId, cursor, INTERNAL_PAGE_SIZE),
        parseIssue,
      );
      this.#assertUniqueIssues(issues);
      this.#assertTeam(issues);
      const labelNames = await this.#labelNames();
      const stateNames = await this.#stateNames();
      const roots: RootInventoryItem[] = [];
      for (const issue of issues) {
        if (issueKind(issue, labelNames) !== "root") continue;
        if (issue.snapshot.delegate_id !== this.#delegateActorId) continue;
        if (issue.snapshot.parent_id !== null) fail("linear_root_has_parent");
        roots.push(Object.freeze({
          root_id: parseRootIssueId(issue.snapshot.issue_id),
          revision: issue.snapshot.revision,
          status: parseProviderEnum(stateNames.get(issue.snapshot.status), ROOT_STATUSES),
          priority: issue.snapshot.priority ?? 0,
          created_at: issue.createdAt,
        }));
      }
      roots.sort((left, right) => left.priority - right.priority
        || left.created_at.localeCompare(right.created_at)
        || left.root_id.localeCompare(right.root_id));
      return Object.freeze(roots);
    });
  }

  readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot> {
    return this.#boundary(async () => {
      const parsedRootId = parseRootIssueId(rootId);
      const labelNames = await this.#labelNames();
      const stateNames = await this.#stateNames();
      const root = await this.#issue(parseTaskIssueId(parsedRootId));
      this.#assertTeam([root]);
      if (root.snapshot.issue_id !== parseTaskIssueId(parsedRootId)) fail("linear_root_identity_mismatch");
      if (root.snapshot.parent_id !== null) fail("linear_root_has_parent");
      if (root.snapshot.delegate_id !== this.#delegateActorId) fail("linear_root_delegate_mismatch");
      if (issueKind(root, labelNames) !== "root") fail("linear_root_kind_mismatch");
      parseProviderEnum(stateNames.get(root.snapshot.status), ROOT_STATUSES);

      const cycles = await this.#children(root.snapshot.issue_id);
      this.#assertUniqueIssues(cycles);
      let activeCycles = 0;
      const issues = [root];
      for (const cycle of cycles) {
        if (cycle.snapshot.parent_id !== root.snapshot.issue_id) fail("linear_cycle_parent_mismatch");
        if (issueKind(cycle, labelNames) !== "cycle") fail("linear_cycle_kind_mismatch");
        const status = parseProviderEnum(stateNames.get(cycle.snapshot.status), CYCLE_STATUSES);
        if (ACTIVE_CYCLE_STATUSES.has(status)) activeCycles += 1;
        const stages = await this.#children(cycle.snapshot.issue_id);
        this.#assertUniqueIssues(stages);
        for (const stage of stages) {
          if (stage.snapshot.parent_id !== cycle.snapshot.issue_id) fail("linear_stage_parent_mismatch");
          if (!STAGE_KINDS.includes(issueKind(stage, labelNames) as typeof STAGE_KINDS[number])) {
            fail("linear_stage_kind_mismatch");
          }
          parseProviderEnum(stateNames.get(stage.snapshot.status), STAGE_STATUSES);
          if ((await this.#children(stage.snapshot.issue_id)).length !== 0) fail("linear_stage_has_children");
        }
        issues.push(cycle, ...stages);
      }
      if (activeCycles > 1) fail("linear_multiple_active_cycles");
      this.#assertUniqueIssues(issues);

      const relations = new Map<string, TaskRelationSnapshot>();
      for (const issue of issues) {
        for (const relation of await this.#relations(issue.snapshot.issue_id)) {
          const current = relations.get(relation.relation_id);
          if (current && (
            current.revision !== relation.revision
            || current.type !== relation.type
            || current.source_issue_id !== relation.source_issue_id
            || current.target_issue_id !== relation.target_issue_id
          )) fail("linear_relation_identity_conflict");
          relations.set(relation.relation_id, relation);
        }
      }
      const issueIds = new Set(issues.map(({ snapshot }) => snapshot.issue_id));
      for (const relation of relations.values()) {
        if (!issueIds.has(relation.source_issue_id) || !issueIds.has(relation.target_issue_id)) {
          fail("linear_external_relation");
        }
      }
      return parseTaskSnapshot({
        root_id: parsedRootId,
        issues: issues.map(({ snapshot }) => snapshot).sort((left, right) => left.issue_id.localeCompare(right.issue_id)),
        relations: [...relations.values()].sort((left, right) => left.relation_id.localeCompare(right.relation_id)),
      });
    });
  }

  async #issue(issueId: TaskIssueId): Promise<LinearIssueRecord> {
    return parseIssue(await this.client.getIssue(issueId));
  }

  #children(issueId: TaskIssueId): Promise<readonly LinearIssueRecord[]> {
    return this.#all((cursor) => this.client.listChildren(issueId, cursor, INTERNAL_PAGE_SIZE), parseIssue);
  }

  #relations(issueId: TaskIssueId): Promise<readonly TaskRelationSnapshot[]> {
    return this.#all((cursor) => this.client.listRelations(issueId, cursor, INTERNAL_PAGE_SIZE), parseRelation);
  }

  async #stateNames(): Promise<ReadonlyMap<string, string>> {
    const states = await this.#all(
      (cursor) => this.client.listStates(this.#teamId, cursor, INTERNAL_PAGE_SIZE),
      parseState,
    );
    const names = new Map<string, string>();
    for (const state of states) {
      if (state.team_id !== this.#teamId) fail("linear_team_mismatch");
      if (names.has(state.state_id)) fail("linear_duplicate_state_identity");
      names.set(state.state_id, state.name);
    }
    return names;
  }

  async #labelNames(): Promise<ReadonlyMap<string, string>> {
    const labels = await this.#all(
      (cursor) => this.client.listLabels(this.#teamId, cursor, INTERNAL_PAGE_SIZE),
      parseLabel,
    );
    const names = new Map<string, string>();
    for (const label of labels) {
      if (label.team_id !== null && label.team_id !== this.#teamId) fail("linear_team_mismatch");
      if (names.has(label.label_id)) fail("linear_duplicate_label_identity");
      names.set(label.label_id, label.name);
    }
    return names;
  }

  async #all<T>(fetch: (cursor: string | null) => Promise<unknown>, parser: (entry: unknown) => T): Promise<readonly T[]> {
    const nodes: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page: Page<T> = parsePage(await fetch(cursor), parser, INTERNAL_PAGE_SIZE);
      nodes.push(...page.nodes);
      if (nodes.length > MAX_NODES) fail("linear_node_limit_exceeded");
      if (page.nextCursor === null) return Object.freeze(nodes);
      if (page.nextCursor === cursor || cursors.has(page.nextCursor)) fail("linear_cursor_cycle");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return fail("linear_page_limit_exceeded");
  }

  #assertTeam(issues: readonly LinearIssueRecord[]): void {
    for (const issue of issues) if (issue.teamId !== this.#teamId) fail("linear_team_mismatch");
  }

  #assertUniqueIssues(issues: readonly LinearIssueRecord[]): void {
    if (new Set(issues.map(({ snapshot }) => snapshot.issue_id)).size !== issues.length) {
      fail("linear_duplicate_issue_identity");
    }
  }

  async #boundary<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof LinearQueryError) throw new Error(error.message);
      throw new Error("linear_boundary_unavailable");
    }
  }
}
