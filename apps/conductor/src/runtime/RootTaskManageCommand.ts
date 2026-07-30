import { Buffer } from "node:buffer";

import {
  parseRootIssueId,
  parseTaskIssueId,
  type RootIssueId,
  type TaskIssueId,
  type TaskRelationId,
} from "../contracts/identity.js";
import {
  parseTaskSnapshot,
  type ConcreteTaskChange,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
  type TaskSnapshot,
} from "../contracts/observation.js";
import { taskSnapshotDigest } from "../observation/TaskFacts.js";
import type {
  TaskManageCommandInterface,
  TaskManageExecution,
} from "../task-management/api/TaskManageCommandInterface.js";
import {
  parseTaskMcpResult,
  type ArchiveIssueCall,
  type ArchiveIssueResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateRelationCall,
  type CreateRelationResult,
  type DeleteRelationCall,
  type DeleteRelationResult,
  type GetIssueCall,
  type GetIssueResult,
  type ListChildrenCall,
  type ListChildrenResult,
  type ListIssuesCall,
  type ListIssuesResult,
  type ListLabelsCall,
  type ListLabelsResult,
  type ListRelationsCall,
  type ListRelationsResult,
  type ListStatesCall,
  type ListStatesResult,
  type TaskMcpCall,
  type TaskMcpMutationCall,
  type TaskMcpMutationResult,
  type TaskMcpResult,
  type UpdateIssueCall,
  type UpdateIssueResult,
} from "../task-management/mcp/TaskMcpSchemas.js";

const ISSUE_LIST_CURSOR_PREFIX = "root-issues:1";
const RELATION_LIST_CURSOR_PREFIX = "root-relations:1";

export interface RootTaskSnapshotReader {
  readRootSnapshot(rootId: RootIssueId): Promise<TaskSnapshot>;
}

export interface BindRootTaskManageCommandOptions {
  readonly root_id: RootIssueId;
  readonly task_manager: TaskManageCommandInterface;
  readonly snapshot_reader: RootTaskSnapshotReader;
}

export class RootTaskManageBindingError extends Error {
  constructor(
    readonly code: "invalid_contract" | "capability_denied" | "boundary_unavailable",
    readonly fatal: boolean,
  ) {
    super(code);
    this.name = "RootTaskManageBindingError";
  }
}

interface RootScope {
  readonly snapshot: TaskSnapshot;
  readonly root_issue_id: TaskIssueId;
  readonly issues: ReadonlyMap<TaskIssueId, TaskSnapshot["issues"][number]>;
  readonly relations: ReadonlyMap<TaskRelationId, TaskSnapshot["relations"][number]>;
}

function callDenied(): never {
  throw new RootTaskManageBindingError("capability_denied", false);
}

function invalidBoundary(): never {
  throw new RootTaskManageBindingError("invalid_contract", true);
}

function invalidCall(): never {
  throw new RootTaskManageBindingError("invalid_contract", false);
}

function assertRootedSnapshot(snapshot: TaskSnapshot): void {
  const rootIssueId = parseTaskIssueId(snapshot.root_id);
  const issues = new Map(snapshot.issues.map((issue) => [issue.issue_id, issue]));
  for (const issue of snapshot.issues) {
    if (issue.issue_id === rootIssueId) continue;
    const visited = new Set<TaskIssueId>();
    let current = issue;
    while (current.issue_id !== rootIssueId) {
      if (visited.has(current.issue_id) || current.parent_id === null) invalidBoundary();
      visited.add(current.issue_id);
      const parent = issues.get(current.parent_id);
      if (parent === undefined) invalidBoundary();
      current = parent;
    }
  }
}

function encodeCursorPart(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeCursorPart(value: string): string {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) return invalidCall();
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (encodeCursorPart(decoded) !== value) return invalidCall();
    return decoded;
  } catch {
    return invalidCall();
  }
}

function pageCursor(prefix: string, rootId: RootIssueId, digest: string, anchor: string): string {
  return [
    prefix,
    encodeCursorPart(rootId),
    encodeCursorPart(digest),
    encodeCursorPart(anchor),
  ].join(":");
}

function cursorStart<T>(
  prefix: string,
  cursor: string | null,
  rootId: RootIssueId,
  digest: string,
  entries: readonly T[],
  identity: (entry: T) => string,
): number {
  if (cursor === null) return 0;
  if (cursor.length > 512) invalidCall();
  const parts = cursor.split(":");
  if (
    parts.length !== 5
    || `${parts[0]}:${parts[1]}` !== prefix
    || decodeCursorPart(parts[2] ?? "") !== rootId
    || decodeCursorPart(parts[3] ?? "") !== digest
  ) invalidCall();
  const anchor = decodeCursorPart(parts[4] ?? "");
  const index = entries.findIndex((entry) => identity(entry) === anchor);
  if (index < 0) invalidCall();
  return index + 1;
}

function listResultEnvelope(call: ListIssuesCall): Omit<ListIssuesResult, "output"> {
  return {
    schema_version: call.schema_version,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
  };
}

function validateResult<R extends TaskMcpResult>(
  value: unknown,
  call: TaskMcpCall,
  validate: (result: R) => void,
): R {
  try {
    const result = parseTaskMcpResult(value, call) as R;
    validate(result);
    return result;
  } catch (error) {
    if (error instanceof RootTaskManageBindingError) throw error;
    return invalidBoundary();
  }
}

function assertScopedIssue(
  scope: RootScope,
  issue: TaskIssueSnapshot,
  created?: { readonly issue_id: TaskIssueId; readonly parent_id: TaskIssueId },
): void {
  if (created !== undefined && issue.issue_id === created.issue_id) {
    if (issue.parent_id !== created.parent_id || !scope.issues.has(created.parent_id)) invalidBoundary();
    return;
  }
  if (!scope.issues.has(issue.issue_id)) invalidBoundary();
  if (issue.issue_id === scope.root_issue_id) {
    if (issue.parent_id !== null) invalidBoundary();
  } else if (issue.parent_id === null || !scope.issues.has(issue.parent_id)) {
    invalidBoundary();
  }
}

function assertScopedRelation(
  scope: RootScope,
  relation: TaskRelationSnapshot,
  created?: {
    readonly relation_id: TaskRelationId;
    readonly source_issue_id: TaskIssueId;
    readonly target_issue_id: TaskIssueId;
  },
): void {
  if (
    !scope.issues.has(relation.source_issue_id)
    || !scope.issues.has(relation.target_issue_id)
  ) invalidBoundary();
  if (created !== undefined && relation.relation_id === created.relation_id) {
    if (
      relation.source_issue_id !== created.source_issue_id
      || relation.target_issue_id !== created.target_issue_id
    ) invalidBoundary();
    return;
  }
  const owned = scope.relations.get(relation.relation_id);
  if (
    owned === undefined
    || owned.source_issue_id !== relation.source_issue_id
    || owned.target_issue_id !== relation.target_issue_id
  ) invalidBoundary();
}

export class RootTaskManageCommandBinding implements TaskManageCommandInterface {
  readonly root_id: RootIssueId;
  readonly #provisionalIssues = new Map<TaskIssueId, { readonly parent_id: TaskIssueId }>();
  readonly #retiredIssues = new Map<TaskIssueId, { readonly parent_id: TaskIssueId | null }>();

  private constructor(
    rootId: RootIssueId,
    private readonly taskManager: TaskManageCommandInterface,
    private readonly snapshotReader: RootTaskSnapshotReader,
  ) {
    this.root_id = rootId;
  }

  static bind(options: BindRootTaskManageCommandOptions): RootTaskManageCommandBinding {
    return new RootTaskManageCommandBinding(
      parseRootIssueId(options.root_id),
      options.task_manager,
      options.snapshot_reader,
    );
  }

  async get_issue(call: GetIssueCall, execution: TaskManageExecution): Promise<GetIssueResult> {
    const scope = await this.#scope(call.root_id, execution);
    const owned = scope.issues.has(call.input.issue_id);
    const provisional = this.#provisionalIssues.get(call.input.issue_id);
    const retired = this.#retiredIssues.get(call.input.issue_id);
    if (!owned && provisional === undefined && retired === undefined) callDenied();
    if (
      provisional !== undefined
      && owned
      && scope.issues.get(call.input.issue_id)?.parent_id !== provisional.parent_id
    ) invalidBoundary();
    const value = await this.taskManager.get_issue(call, execution);
    execution.assertActive();
    const result = validateResult<GetIssueResult>(value, call, (parsed) => {
      const issue = parsed.output.issue;
      if (issue !== null && issue.issue_id !== call.input.issue_id) invalidBoundary();
      if (provisional !== undefined) {
        if (issue !== null && issue.parent_id !== provisional.parent_id) invalidBoundary();
        return;
      }
      if (retired !== undefined) {
        if (issue !== null) {
          if (!owned || issue.parent_id !== retired.parent_id) invalidBoundary();
          assertScopedIssue(scope, issue);
        }
        return;
      }
      if (issue !== null) assertScopedIssue(scope, issue);
    });
    if (provisional !== undefined) this.#provisionalIssues.delete(call.input.issue_id);
    if (retired !== undefined) this.#retiredIssues.delete(call.input.issue_id);
    return result;
  }

  async list_issues(call: ListIssuesCall, execution: TaskManageExecution): Promise<ListIssuesResult> {
    const scope = await this.#scope(call.root_id, execution);
    const issues = [...scope.snapshot.issues].sort((left, right) =>
      left.issue_id.localeCompare(right.issue_id));
    const digest = taskSnapshotDigest(scope.snapshot);
    const start = cursorStart(
      ISSUE_LIST_CURSOR_PREFIX,
      call.input.cursor,
      this.root_id,
      digest,
      issues,
      (issue) => issue.issue_id,
    );
    const page = Object.freeze(issues.slice(start, start + call.input.page_size));
    const last = page.at(-1);
    const nextCursor = last !== undefined && start + page.length < issues.length
      ? pageCursor(ISSUE_LIST_CURSOR_PREFIX, this.root_id, digest, last.issue_id)
      : null;
    return Object.freeze({
      ...listResultEnvelope(call),
      output: Object.freeze({ issues: page, next_cursor: nextCursor }),
    });
  }

  async list_children(call: ListChildrenCall, execution: TaskManageExecution): Promise<ListChildrenResult> {
    const scope = await this.#scope(call.root_id, execution);
    this.#ownedIssue(scope, call.input.parent_issue_id);
    const value = await this.taskManager.list_children(call, execution);
    execution.assertActive();
    return validateResult<ListChildrenResult>(value, call, (result) => {
      for (const issue of result.output.issues) {
        assertScopedIssue(scope, issue);
        if (issue.parent_id !== call.input.parent_issue_id) invalidBoundary();
      }
    });
  }

  async create_issue(call: CreateIssueCall, execution: TaskManageExecution): Promise<CreateIssueResult> {
    const scope = await this.#scope(call.root_id, execution);
    this.#ownedIssue(scope, call.input.parent_issue_id);
    const value = await this.taskManager.create_issue(call, execution);
    execution.assertActive();
    const result = validateResult<CreateIssueResult>(value, call, (parsed) =>
      this.#assertMutationResult(scope, call, parsed));
    if (result.output.outcome === "acceptance_unknown" && result.output.target.kind === "issue") {
      if (
        this.#provisionalIssues.size >= 8
        && !this.#provisionalIssues.has(result.output.target.issue_id)
      ) invalidBoundary();
      this.#provisionalIssues.set(result.output.target.issue_id, Object.freeze({
        parent_id: call.input.parent_issue_id,
      }));
    }
    return result;
  }

  async update_issue(call: UpdateIssueCall, execution: TaskManageExecution): Promise<UpdateIssueResult> {
    const scope = await this.#scope(call.root_id, execution);
    this.#ownedIssue(scope, call.input.issue_id);
    if ("parent_id" in call.input.desired) {
      this.#ownedParentChange(scope, call.input.issue_id, call.input.desired.parent_id);
    }
    const value = await this.taskManager.update_issue(call, execution);
    execution.assertActive();
    return this.#validateIssueMutationResult<UpdateIssueResult>(scope, call, value, execution);
  }

  async archive_issue(call: ArchiveIssueCall, execution: TaskManageExecution): Promise<ArchiveIssueResult> {
    const scope = await this.#scope(call.root_id, execution);
    this.#ownedIssue(scope, call.input.issue_id);
    const value = await this.taskManager.archive_issue(call, execution);
    execution.assertActive();
    const result = await this.#validateIssueMutationResult<ArchiveIssueResult>(
      scope,
      call,
      value,
      execution,
    );
    if (result.output.outcome === "acceptance_unknown" && result.output.target.kind === "issue") {
      if (this.#retiredIssues.size >= 8 && !this.#retiredIssues.has(result.output.target.issue_id)) {
        invalidBoundary();
      }
      const issue = scope.issues.get(result.output.target.issue_id);
      if (issue === undefined) invalidBoundary();
      this.#retiredIssues.set(result.output.target.issue_id, Object.freeze({ parent_id: issue.parent_id }));
    }
    return result;
  }

  async list_relations(call: ListRelationsCall, execution: TaskManageExecution): Promise<ListRelationsResult> {
    const scope = await this.#scope(call.root_id, execution);
    this.#ownedIssue(scope, call.input.issue_id);
    const relations = scope.snapshot.relations
      .filter((relation) => relation.source_issue_id === call.input.issue_id
        || relation.target_issue_id === call.input.issue_id)
      .sort((left, right) => left.relation_id.localeCompare(right.relation_id));
    const digest = taskSnapshotDigest(scope.snapshot);
    const start = cursorStart(
      RELATION_LIST_CURSOR_PREFIX,
      call.input.cursor,
      this.root_id,
      digest,
      relations,
      (relation) => relation.relation_id,
    );
    const page = Object.freeze(relations.slice(start, start + call.input.page_size));
    const last = page.at(-1);
    const nextCursor = last !== undefined && start + page.length < relations.length
      ? pageCursor(RELATION_LIST_CURSOR_PREFIX, this.root_id, digest, last.relation_id)
      : null;
    return Object.freeze({
      schema_version: call.schema_version,
      function: call.function,
      root_id: call.root_id,
      runtime_generation: call.runtime_generation,
      correlation_id: call.correlation_id,
      capability: call.capability,
      output: Object.freeze({ relations: page, next_cursor: nextCursor }),
    });
  }

  async create_relation(call: CreateRelationCall, execution: TaskManageExecution): Promise<CreateRelationResult> {
    const scope = await this.#scope(call.root_id, execution);
    this.#ownedIssue(scope, call.input.source_issue_id);
    this.#ownedIssue(scope, call.input.target_issue_id);
    const value = await this.taskManager.create_relation(call, execution);
    execution.assertActive();
    return validateResult<CreateRelationResult>(value, call, (result) =>
      this.#assertMutationResult(scope, call, result));
  }

  async delete_relation(call: DeleteRelationCall, execution: TaskManageExecution): Promise<DeleteRelationResult> {
    const scope = await this.#scope(call.root_id, execution);
    this.#ownedIssue(scope, call.input.source_issue_id);
    this.#ownedIssue(scope, call.input.target_issue_id);
    const relation = scope.snapshot.relations.find(({ relation_id }) =>
      relation_id === call.input.relation_id);
    if (
      relation === undefined
      || relation.source_issue_id !== call.input.source_issue_id
      || relation.target_issue_id !== call.input.target_issue_id
    ) callDenied();
    const value = await this.taskManager.delete_relation(call, execution);
    execution.assertActive();
    return validateResult<DeleteRelationResult>(value, call, (result) =>
      this.#assertMutationResult(scope, call, result));
  }

  async list_states(call: ListStatesCall, execution: TaskManageExecution): Promise<ListStatesResult> {
    await this.#scope(call.root_id, execution);
    const value = await this.taskManager.list_states(call, execution);
    execution.assertActive();
    return validateResult<ListStatesResult>(value, call, () => undefined);
  }

  async list_labels(call: ListLabelsCall, execution: TaskManageExecution): Promise<ListLabelsResult> {
    await this.#scope(call.root_id, execution);
    const value = await this.taskManager.list_labels(call, execution);
    execution.assertActive();
    return validateResult<ListLabelsResult>(value, call, () => undefined);
  }

  async #scope(callRootId: RootIssueId, execution: TaskManageExecution): Promise<RootScope> {
    if (callRootId !== this.root_id) callDenied();
    execution.assertActive();
    let rawSnapshot: unknown;
    try {
      rawSnapshot = await this.snapshotReader.readRootSnapshot(this.root_id);
    } catch {
      throw new RootTaskManageBindingError("boundary_unavailable", true);
    }
    let snapshot: TaskSnapshot;
    try {
      snapshot = parseTaskSnapshot(rawSnapshot);
      assertRootedSnapshot(snapshot);
    } catch (error) {
      if (error instanceof RootTaskManageBindingError) throw error;
      return invalidBoundary();
    }
    execution.assertActive();
    if (snapshot.root_id !== this.root_id) invalidBoundary();
    return Object.freeze({
      snapshot,
      root_issue_id: parseTaskIssueId(snapshot.root_id),
      issues: new Map(snapshot.issues.map((issue) => [issue.issue_id, issue])),
      relations: new Map(snapshot.relations.map((relation) => [relation.relation_id, relation])),
    });
  }

  async #validateIssueMutationResult<R extends UpdateIssueResult | ArchiveIssueResult>(
    scope: RootScope,
    call: UpdateIssueCall | ArchiveIssueCall,
    value: unknown,
    execution: TaskManageExecution,
  ): Promise<R> {
    const result = validateResult<R>(value, call, () => undefined);
    try {
      this.#assertMutationResult(scope, call, result);
      return result;
    } catch (error) {
      if (
        !(error instanceof RootTaskManageBindingError)
        || error.code !== "invalid_contract"
        || !error.fatal
        || result.output.outcome !== "precondition_failed"
      ) throw error;
      const latestScope = await this.#scope(call.root_id, execution);
      if (latestScope.issues.has(call.input.issue_id)) throw error;
      this.#assertScopeLossConflict(call, result);
      return validateResult<R>({
        ...result,
        output: {
          ...result.output,
          fresh_resource: null,
          concrete_diff: [],
          sanitized_reason: "fresh_precondition_scope_changed",
        },
      }, call, () => undefined);
    }
  }

  #assertScopeLossConflict(
    call: UpdateIssueCall | ArchiveIssueCall,
    result: UpdateIssueResult | ArchiveIssueResult,
  ): void {
    const fresh = result.output.fresh_resource;
    if (fresh !== null && (!("issue_id" in fresh) || fresh.issue_id !== call.input.issue_id)) {
      invalidBoundary();
    }
    for (const change of result.output.concrete_diff) {
      if (call.function === "update_issue") {
        if (change.kind !== "field_changed" || change.issue_id !== call.input.issue_id) {
          invalidBoundary();
        }
      } else if (change.kind !== "issue_archived" || change.issue.issue_id !== call.input.issue_id) {
        invalidBoundary();
      }
    }
  }

  #assertMutationResult(
    scope: RootScope,
    call: TaskMcpMutationCall,
    result: TaskMcpMutationResult,
  ): void {
    const target = result.output.target;
    let createdIssue: { readonly issue_id: TaskIssueId; readonly parent_id: TaskIssueId } | undefined;
    let createdRelation: {
      readonly relation_id: TaskRelationId;
      readonly source_issue_id: TaskIssueId;
      readonly target_issue_id: TaskIssueId;
    } | undefined;
    switch (call.function) {
      case "create_issue":
        if (target.kind !== "issue" || scope.issues.has(target.issue_id)) invalidBoundary();
        createdIssue = {
          issue_id: target.issue_id,
          parent_id: call.input.parent_issue_id,
        };
        break;
      case "update_issue":
      case "archive_issue":
        if (target.kind !== "issue" || !scope.issues.has(target.issue_id)) invalidBoundary();
        break;
      case "create_relation":
        if (target.kind !== "relation" || scope.relations.has(target.relation_id)) invalidBoundary();
        createdRelation = {
          relation_id: target.relation_id,
          source_issue_id: call.input.source_issue_id,
          target_issue_id: call.input.target_issue_id,
        };
        break;
      case "delete_relation":
        if (target.kind !== "relation" || !scope.relations.has(target.relation_id)) invalidBoundary();
        break;
    }

    const fresh = result.output.fresh_resource;
    if (fresh !== null) {
      if ("issue_id" in fresh) {
        if (target.kind !== "issue" || fresh.issue_id !== target.issue_id) invalidBoundary();
        assertScopedIssue(scope, fresh, createdIssue);
      } else {
        if (target.kind !== "relation" || fresh.relation_id !== target.relation_id) invalidBoundary();
        assertScopedRelation(scope, fresh, createdRelation);
      }
    }
    for (const change of result.output.concrete_diff) {
      this.#assertMutationChange(scope, call, target, change, createdIssue, createdRelation);
    }
  }

  #assertMutationChange(
    scope: RootScope,
    call: TaskMcpMutationCall,
    target: TaskMcpMutationResult["output"]["target"],
    change: ConcreteTaskChange,
    createdIssue: { readonly issue_id: TaskIssueId; readonly parent_id: TaskIssueId } | undefined,
    createdRelation: {
      readonly relation_id: TaskRelationId;
      readonly source_issue_id: TaskIssueId;
      readonly target_issue_id: TaskIssueId;
    } | undefined,
  ): void {
    switch (change.kind) {
      case "issue_created":
        if (
          call.function !== "create_issue"
          || target.kind !== "issue"
          || change.issue.issue_id !== target.issue_id
        ) invalidBoundary();
        assertScopedIssue(scope, change.issue, createdIssue);
        return;
      case "issue_archived":
        if (
          call.function !== "archive_issue"
          || target.kind !== "issue"
          || change.issue.issue_id !== target.issue_id
        ) invalidBoundary();
        assertScopedIssue(scope, change.issue);
        return;
      case "field_changed":
        if (
          call.function !== "update_issue"
          || target.kind !== "issue"
          || change.issue_id !== target.issue_id
          || !scope.issues.has(change.issue_id)
        ) invalidBoundary();
        if (change.field === "parent") {
          this.#assertOwnedParentValue(scope, change.issue_id, change.before);
          this.#assertOwnedParentValue(scope, change.issue_id, change.after);
        }
        return;
      case "relation_added":
        if (
          call.function !== "create_relation"
          || target.kind !== "relation"
          || change.relation.relation_id !== target.relation_id
        ) invalidBoundary();
        assertScopedRelation(scope, change.relation, createdRelation);
        return;
      case "relation_removed":
        if (
          call.function !== "delete_relation"
          || target.kind !== "relation"
          || change.relation.relation_id !== target.relation_id
        ) invalidBoundary();
        assertScopedRelation(scope, change.relation);
    }
  }

  #ownedIssue(scope: RootScope, issueId: TaskIssueId): void {
    if (!scope.issues.has(issueId)) callDenied();
  }

  #assertOwnedParentValue(
    scope: RootScope,
    issueId: TaskIssueId,
    parentId: TaskIssueId | null,
  ): void {
    if (issueId === scope.root_issue_id) {
      if (parentId !== null) invalidBoundary();
    } else if (parentId === null || !scope.issues.has(parentId)) {
      invalidBoundary();
    }
  }

  #ownedParentChange(
    scope: RootScope,
    issueId: TaskIssueId,
    parentId: TaskIssueId | null | undefined,
  ): void {
    if (parentId === undefined) return;
    if (issueId === scope.root_issue_id) {
      if (parentId !== null) callDenied();
      return;
    }
    if (parentId === null || !scope.issues.has(parentId) || parentId === issueId) callDenied();
    let ancestor = scope.issues.get(parentId);
    const visited = new Set<TaskIssueId>();
    while (ancestor !== undefined && ancestor.issue_id !== scope.root_issue_id) {
      if (ancestor.issue_id === issueId || visited.has(ancestor.issue_id)) callDenied();
      visited.add(ancestor.issue_id);
      ancestor = ancestor.parent_id === null ? undefined : scope.issues.get(ancestor.parent_id);
    }
  }
}

export function bindRootTaskManageCommand(
  options: BindRootTaskManageCommandOptions,
): RootTaskManageCommandBinding {
  return RootTaskManageCommandBinding.bind(options);
}
