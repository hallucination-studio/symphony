import {
  parseCycleIssueId,
  parseRepositoryId,
  parseRootIssueId,
  parseStageIssueId,
  type RepositoryId,
  type RootIssueId,
} from "../../contracts/identity.js";
import {
  CYCLE_STATUSES,
  parseLinearObservation,
  ROOT_STATUSES,
  STAGE_KINDS,
  STAGE_STATUSES,
  type CycleStatus,
  type LinearObservation,
  type StageKind,
  type StageObservation,
} from "../../contracts/observation.js";
import { asRecord, assertExactKeys, parseBoundedString, parseEnum } from "../../contracts/validation.js";
import type { LinearGatewayInterface, RootCandidate } from "../api/LinearGatewayInterface.js";

const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 5_000;
const KIND_PREFIX = "symphony:kind/";
const ACTIVE_CYCLE_STATUSES = new Set<CycleStatus>(["Planning", "Executing", "Verifying"]);

export interface LinearReaderRoute {
  readonly root_id: RootIssueId;
  readonly repository_id: RepositoryId;
  readonly base_branch: string;
}

export interface LinearReaderOptions {
  readonly team_id: string;
  readonly routes: readonly LinearReaderRoute[];
}

export interface LinearReadClient {
  listTeamIssues(teamId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  getIssue(issueId: string): Promise<unknown>;
  listIssueLabels(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listIssueChildren(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  listIssueInverseRelations(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
}

interface Page<T> {
  readonly nodes: readonly T[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

interface IssueRecord {
  readonly id: string;
  readonly teamId: string;
  readonly parentId: string | null;
  readonly status: string;
  readonly priority: number;
  readonly createdAt: string;
}

interface RelationRecord {
  readonly type: string;
  readonly sourceIssueId: string;
  readonly targetIssueId: string;
}

function invalidPayload(): never {
  throw new Error("linear_invalid_payload");
}

function parsePage<T>(value: unknown, parseNode: (node: unknown) => T): Page<T> {
  try {
    const record = asRecord(value);
    assertExactKeys(record, ["nodes", "page_info"]);
    if (!Array.isArray(record.nodes)) invalidPayload();
    const pageInfo = asRecord(record.page_info);
    assertExactKeys(pageInfo, ["has_next_page", "end_cursor"]);
    if (typeof pageInfo.has_next_page !== "boolean") invalidPayload();
    if (pageInfo.end_cursor !== null && typeof pageInfo.end_cursor !== "string") invalidPayload();
    return Object.freeze({
      nodes: Object.freeze(record.nodes.map(parseNode)),
      hasNextPage: pageInfo.has_next_page,
      endCursor: pageInfo.end_cursor as string | null,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "linear_invalid_payload") throw error;
    return invalidPayload();
  }
}

function parseIssue(value: unknown): IssueRecord {
  try {
    const record = asRecord(value);
    assertExactKeys(record, ["id", "team_id", "parent_id", "status", "priority", "created_at"]);
    const id = parseBoundedString(record.id, "invalid_issue_id", 128);
    const teamId = parseBoundedString(record.team_id, "invalid_team_id", 128);
    const parentId = record.parent_id === null
      ? null
      : parseBoundedString(record.parent_id, "invalid_parent_id", 128);
    const status = parseBoundedString(record.status, "invalid_issue_status", 128);
    if (!Number.isSafeInteger(record.priority) || (record.priority as number) < 0 || (record.priority as number) > 4) {
      invalidPayload();
    }
    const createdAt = parseBoundedString(record.created_at, "invalid_created_at", 64);
    if (Number.isNaN(Date.parse(createdAt))) invalidPayload();
    return Object.freeze({ id, teamId, parentId, status, priority: record.priority as number, createdAt });
  } catch (error) {
    if (error instanceof Error && error.message === "linear_invalid_payload") throw error;
    return invalidPayload();
  }
}

function parseLabel(value: unknown): string {
  try {
    return parseBoundedString(value, "invalid_label", 128);
  } catch {
    return invalidPayload();
  }
}

function parseRelation(value: unknown): RelationRecord {
  try {
    const record = asRecord(value);
    assertExactKeys(record, ["type", "source_issue_id", "target_issue_id"]);
    return Object.freeze({
      type: parseBoundedString(record.type, "invalid_relation_type", 32),
      sourceIssueId: parseBoundedString(record.source_issue_id, "invalid_source_issue_id", 128),
      targetIssueId: parseBoundedString(record.target_issue_id, "invalid_target_issue_id", 128),
    });
  } catch {
    return invalidPayload();
  }
}

function workflowKind(labels: readonly string[]): "root" | "cycle" | StageKind | null {
  const kinds = labels.filter((label) => label.startsWith(KIND_PREFIX));
  if (kinds.length === 0) return null;
  if (kinds.length !== 1) throw new Error("linear_ambiguous_kind");
  const kind = kinds[0]?.slice(KIND_PREFIX.length);
  if (kind === "root" || kind === "cycle" || STAGE_KINDS.includes(kind as StageKind)) return kind as "root" | "cycle" | StageKind;
  throw new Error("linear_invalid_kind");
}

export class LinearReader implements Pick<LinearGatewayInterface, "discoverRoots" | "readRoot"> {
  readonly #routes: ReadonlyMap<RootIssueId, LinearReaderRoute>;
  readonly #teamId: string;

  constructor(private readonly client: LinearReadClient, options: LinearReaderOptions) {
    this.#teamId = parseBoundedString(options.team_id, "invalid_linear_team_id", 128);
    const routes = new Map<RootIssueId, LinearReaderRoute>();
    for (const route of options.routes) {
      const rootId = parseRootIssueId(route.root_id);
      if (routes.has(rootId)) throw new Error("duplicate_root_routing");
      routes.set(rootId, Object.freeze({
        root_id: rootId,
        repository_id: parseRepositoryId(route.repository_id),
        base_branch: parseBoundedString(route.base_branch, "invalid_base_branch", 255),
      }));
    }
    this.#routes = routes;
  }

  async discoverRoots(): Promise<readonly RootCandidate[]> {
    const issues = await this.#all((cursor) => this.client.listTeamIssues(this.#teamId, cursor, PAGE_SIZE), parseIssue);
    this.#assertUniqueIssues(issues);
    const candidates: RootCandidate[] = [];
    for (const issue of issues) {
      this.#assertTeam(issue);
      const labels = await this.#labels(issue.id);
      if (workflowKind(labels) !== "root") continue;
      if (issue.parentId !== null) throw new Error("linear_root_has_parent");
      const rootId = parseRootIssueId(issue.id);
      const route = this.#routes.get(rootId);
      if (!route) throw new Error("linear_root_route_missing");
      candidates.push(Object.freeze({
        root_id: rootId,
        status: parseEnum(issue.status, ROOT_STATUSES),
        priority: issue.priority,
        created_at: new Date(issue.createdAt).toISOString(),
        repository_id: route.repository_id,
        base_branch: route.base_branch,
      }));
    }
    candidates.sort((left, right) => left.priority - right.priority
      || left.created_at.localeCompare(right.created_at)
      || left.root_id.localeCompare(right.root_id));
    return Object.freeze(candidates);
  }

  async readRoot(rootId: RootIssueId): Promise<LinearObservation> {
    const parsedRootId = parseRootIssueId(rootId);
    if (!this.#routes.has(parsedRootId)) throw new Error("linear_root_route_missing");
    const root = await this.#issue(parsedRootId);
    this.#assertTeam(root);
    if (root.id !== parsedRootId) throw new Error("linear_root_identity_mismatch");
    if (root.parentId !== null) throw new Error("linear_root_has_parent");
    if (workflowKind(await this.#labels(root.id)) !== "root") throw new Error("linear_root_kind_mismatch");
    const rootStatus = parseEnum(root.status, ROOT_STATUSES);

    const cycleRecords = await this.#all(
      (cursor) => this.client.listIssueChildren(root.id, cursor, PAGE_SIZE),
      parseIssue,
    );
    this.#assertUniqueIssues(cycleRecords);
    const cycles: Array<{ issue: IssueRecord; status: CycleStatus }> = [];
    for (const cycle of cycleRecords) {
      this.#assertTeam(cycle);
      if (cycle.parentId !== root.id) throw new Error("linear_cycle_parent_mismatch");
      if (workflowKind(await this.#labels(cycle.id)) !== "cycle") throw new Error("linear_cycle_kind_mismatch");
      cycles.push({ issue: cycle, status: parseEnum(cycle.status, CYCLE_STATUSES) });
    }
    const activeCycles = cycles.filter(({ status }) => ACTIVE_CYCLE_STATUSES.has(status));
    if (activeCycles.length > 1) throw new Error("linear_multiple_active_cycles");
    const active = activeCycles[0];
    if (!active) return parseLinearObservation({ root_id: parsedRootId, root_status: rootStatus, active_cycle: null });

    return parseLinearObservation({
      root_id: parsedRootId,
      root_status: rootStatus,
      active_cycle: {
        issue_id: parseCycleIssueId(active.issue.id),
        status: active.status,
        stages: await this.#stages(active.issue),
      },
    });
  }

  async #stages(cycle: IssueRecord): Promise<readonly StageObservation[]> {
    const records = await this.#all(
      (cursor) => this.client.listIssueChildren(cycle.id, cursor, PAGE_SIZE),
      parseIssue,
    );
    this.#assertUniqueIssues(records);
    const staged: Array<{ issue: IssueRecord; kind: StageKind }> = [];
    for (const issue of records) {
      this.#assertTeam(issue);
      if (issue.parentId !== cycle.id) throw new Error("linear_stage_parent_mismatch");
      const kind = workflowKind(await this.#labels(issue.id));
      if (!kind || kind === "root" || kind === "cycle") throw new Error("linear_stage_kind_mismatch");
      parseEnum(issue.status, STAGE_STATUSES);
      staged.push({ issue, kind });
    }
    const byId = new Map(staged.map((stage) => [stage.issue.id, stage]));
    const observations = await Promise.all(staged.map(async ({ issue, kind }): Promise<StageObservation> => {
      const relations = await this.#all(
        (cursor) => this.client.listIssueInverseRelations(issue.id, cursor, PAGE_SIZE),
        parseRelation,
      );
      const dependencies: string[] = [];
      for (const relation of relations) {
        if (relation.type !== "blocks") continue;
        if (relation.targetIssueId !== issue.id) throw new Error("linear_relation_target_mismatch");
        const source = byId.get(relation.sourceIssueId);
        if (!source || source.kind !== "work" || kind === "plan") throw new Error("linear_external_dependency");
        dependencies.push(source.issue.id);
      }
      if (new Set(dependencies).size !== dependencies.length) throw new Error("linear_duplicate_dependency");
      dependencies.sort((left, right) => left.localeCompare(right));
      return Object.freeze({
        issue_id: parseStageIssueId(issue.id),
        kind,
        status: parseEnum(issue.status, STAGE_STATUSES),
        dependency_issue_ids: Object.freeze(dependencies.map(parseStageIssueId)),
      });
    }));
    observations.sort((left, right) => left.issue_id.localeCompare(right.issue_id));
    return Object.freeze(observations);
  }

  async #issue(issueId: string): Promise<IssueRecord> {
    const value = await this.#providerCall(() => this.client.getIssue(issueId));
    return parseIssue(value);
  }

  async #labels(issueId: string): Promise<readonly string[]> {
    return this.#all((cursor) => this.client.listIssueLabels(issueId, cursor, PAGE_SIZE), parseLabel);
  }

  async #all<T>(loader: (cursor: string | null) => Promise<unknown>, parser: (value: unknown) => T): Promise<readonly T[]> {
    const nodes: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const raw = await this.#providerCall(() => loader(cursor));
      const page = parsePage(raw, parser);
      nodes.push(...page.nodes);
      if (nodes.length > MAX_NODES) throw new Error("linear_read_limit_exceeded");
      if (!page.hasNextPage) return Object.freeze(nodes);
      if (!page.endCursor || cursors.has(page.endCursor)) throw new Error("linear_incomplete_page");
      cursors.add(page.endCursor);
      cursor = page.endCursor;
    }
    throw new Error("linear_read_limit_exceeded");
  }

  async #providerCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch {
      throw new Error("linear_boundary_unavailable");
    }
  }

  #assertTeam(issue: IssueRecord): void {
    if (issue.teamId !== this.#teamId) throw new Error("linear_team_mismatch");
  }

  #assertUniqueIssues(issues: readonly IssueRecord[]): void {
    if (new Set(issues.map(({ id }) => id)).size !== issues.length) {
      throw new Error("linear_duplicate_issue_identity");
    }
  }
}
