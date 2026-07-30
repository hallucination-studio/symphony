import { randomUUID } from "node:crypto";

import {
  parseTaskIssueId,
  parseTaskRelationId,
  type TaskIssueId,
  type TaskRelationId,
} from "../../contracts/identity.js";
import {
  type ConcreteTaskChange,
  type TaskIssueSnapshot,
  type TaskRelationSnapshot,
} from "../../contracts/observation.js";
import { parseBoundedString } from "../../contracts/validation.js";
import { taskIssueChanges } from "../../observation/TaskFacts.js";
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
  type TaskMcpMutationCall,
  type TaskMcpMutationResult,
  type TaskMutationOutput,
  type TaskMutationTarget,
  type UpdateIssueCall,
  type UpdateIssueDesired,
  type UpdateIssueResult,
} from "../mcp/TaskMcpSchemas.js";
import {
  assertLinearIssueIdentity,
  linearIssueMatches,
  parseLinearCommandIssue,
  parseLinearMutationReceipt,
  parseLinearRelationPage,
  type LinearCommandIssueRecord,
  type LinearCommandPage,
  type LinearProviderOutcome,
} from "./LinearCommandResources.js";

const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const MAX_NODES = 5_000;
const RELATION_TYPES = new Set(["blocks", "duplicate", "related", "similar"]);

export interface LinearCreateIssueInput {
  readonly id: string;
  readonly team_id: string;
  readonly parent_issue_id: string;
  readonly title: string;
  readonly description: string | null;
  readonly state_id: string;
  readonly label_ids: readonly string[];
  readonly delegate_id: string | null;
  readonly priority: number | null;
}

export interface LinearUpdateIssueInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly state_id?: string;
  readonly parent_issue_id?: string | null;
  readonly label_ids?: readonly string[];
  readonly delegate_id?: string | null;
  readonly priority?: number | null;
}

export interface LinearCreateRelationInput {
  readonly id: string;
  readonly type: string;
  readonly source_issue_id: string;
  readonly target_issue_id: string;
}

export interface LinearCommandClient {
  readIssue(issueId: string): Promise<unknown>;
  listRelations(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  createIssue(input: LinearCreateIssueInput): Promise<unknown>;
  updateIssue(issueId: string, input: LinearUpdateIssueInput): Promise<unknown>;
  archiveIssue(issueId: string): Promise<unknown>;
  createRelation(input: LinearCreateRelationInput): Promise<unknown>;
  deleteRelation(relationId: string): Promise<unknown>;
}

export interface LinearCommandOptions {
  readonly team_id: string;
}

type IdentityFactory = () => string;

function resultEnvelope(call: TaskMcpMutationCall) {
  return {
    schema_version: call.schema_version,
    function: call.function,
    root_id: call.root_id,
    runtime_generation: call.runtime_generation,
    correlation_id: call.correlation_id,
    capability: call.capability,
  };
}

export class LinearCommands {
  readonly #teamId: string;

  constructor(
    private readonly client: LinearCommandClient,
    options: LinearCommandOptions,
    private readonly identityFactory: IdentityFactory = randomUUID,
  ) {
    this.#teamId = parseBoundedString(options.team_id, "invalid_linear_team_id", 128);
  }

  execute(call: CreateIssueCall): Promise<CreateIssueResult>;
  execute(call: UpdateIssueCall): Promise<UpdateIssueResult>;
  execute(call: ArchiveIssueCall): Promise<ArchiveIssueResult>;
  execute(call: CreateRelationCall): Promise<CreateRelationResult>;
  execute(call: DeleteRelationCall): Promise<DeleteRelationResult>;
  execute(call: TaskMcpMutationCall): Promise<TaskMcpMutationResult>;
  async execute(call: TaskMcpMutationCall): Promise<TaskMcpMutationResult> {
    switch (call.function) {
      case "create_issue": return this.#createIssue(call);
      case "update_issue": return this.#updateIssue(call);
      case "archive_issue": return this.#archiveIssue(call);
      case "create_relation": return this.#createRelation(call);
      case "delete_relation": return this.#deleteRelation(call);
    }
  }

  async #createIssue(call: CreateIssueCall): Promise<CreateIssueResult> {
    const issueId = parseTaskIssueId(this.identityFactory());
    const target: TaskMutationTarget = Object.freeze({ kind: "issue", issue_id: issueId });
    const parent = await this.#preconditionIssue(call.input.parent_issue_id);
    if (parent === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (parent.snapshot.revision !== call.input.expected_parent_revision) {
      return this.#result(call, target, "precondition_failed", null, [], "fresh_precondition_mismatch");
    }
    if (call.input.desired.priority !== null && call.input.desired.priority > 4) {
      return this.#result(call, target, "not_applied", null, [], "linear_invalid_priority");
    }
    const provider = await this.#effect(() => this.client.createIssue({
      id: issueId,
      team_id: this.#teamId,
      parent_issue_id: call.input.parent_issue_id,
      title: call.input.desired.title,
      description: call.input.desired.description,
      state_id: call.input.desired.state_id,
      label_ids: call.input.desired.label_ids,
      delegate_id: call.input.desired.delegate_id,
      priority: call.input.desired.priority,
    }));
    let after: LinearCommandIssueRecord;
    try {
      after = await this.#readIssue(issueId);
    } catch {
      return this.#result(call, target, "acceptance_unknown", null, [], "fresh_readback_unavailable");
    }
    const matches = !after.archived
      && after.snapshot.parent_id === call.input.parent_issue_id
      && linearIssueMatches(after.snapshot, {
        title: call.input.desired.title,
        description: call.input.desired.description,
        state_id: call.input.desired.state_id,
        label_ids: call.input.desired.label_ids,
        delegate_id: call.input.desired.delegate_id,
        priority: call.input.desired.priority,
      });
    if (matches) {
      return this.#result(call, target, "applied", after.snapshot, [{ kind: "issue_created", issue: after.snapshot }], null);
    }
    return this.#postconditionFailure(call, target, provider, after.snapshot);
  }

  async #updateIssue(call: UpdateIssueCall): Promise<UpdateIssueResult> {
    const target: TaskMutationTarget = Object.freeze({ kind: "issue", issue_id: call.input.issue_id });
    const before = await this.#preconditionIssue(call.input.issue_id);
    if (before === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (before.snapshot.revision !== call.input.expected_revision) {
      return this.#result(call, target, "precondition_failed", before.snapshot, [], "fresh_precondition_mismatch");
    }
    if (call.input.desired.priority !== undefined && call.input.desired.priority !== null && call.input.desired.priority > 4) {
      return this.#result(call, target, "not_applied", before.snapshot, [], "linear_invalid_priority");
    }
    if (linearIssueMatches(before.snapshot, call.input.desired)) {
      return this.#result(call, target, "not_applied", before.snapshot, [], "desired_state_already_present");
    }
    const provider = await this.#effect(() => this.client.updateIssue(call.input.issue_id, this.#updateInput(call.input.desired)));
    let after: LinearCommandIssueRecord;
    try {
      after = await this.#readIssue(call.input.issue_id);
    } catch {
      return this.#result(call, target, "acceptance_unknown", null, [], "fresh_readback_unavailable");
    }
    if (!after.archived && linearIssueMatches(after.snapshot, call.input.desired)) {
      const changes = taskIssueChanges(before.snapshot, after.snapshot);
      if (changes.length > 0) return this.#result(call, target, "applied", after.snapshot, changes, null);
    }
    return this.#postconditionFailure(call, target, provider, after.snapshot);
  }

  async #archiveIssue(call: ArchiveIssueCall): Promise<ArchiveIssueResult> {
    const target: TaskMutationTarget = Object.freeze({ kind: "issue", issue_id: call.input.issue_id });
    const before = await this.#preconditionIssue(call.input.issue_id);
    if (before === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (before.snapshot.revision !== call.input.expected_revision) {
      return this.#result(call, target, "precondition_failed", before.snapshot, [], "fresh_precondition_mismatch");
    }
    if (before.archived) return this.#result(call, target, "not_applied", before.snapshot, [], "desired_state_already_present");
    const provider = await this.#effect(() => this.client.archiveIssue(call.input.issue_id));
    let after: LinearCommandIssueRecord;
    try {
      after = await this.#readIssue(call.input.issue_id);
    } catch {
      return this.#result(call, target, "acceptance_unknown", null, [], "fresh_readback_unavailable");
    }
    if (after.archived) {
      return this.#result(call, target, "applied", after.snapshot, [{ kind: "issue_archived", issue: after.snapshot }], null);
    }
    return this.#postconditionFailure(call, target, provider, after.snapshot);
  }

  async #createRelation(call: CreateRelationCall): Promise<CreateRelationResult> {
    const relationId = parseTaskRelationId(this.identityFactory());
    const target = this.#relationTarget(relationId, call.input.source_issue_id, call.input.target_issue_id);
    const endpoints = await this.#preconditionEndpoints(call.input.source_issue_id, call.input.target_issue_id);
    if (endpoints === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (
      endpoints[0].snapshot.revision !== call.input.expected_source_revision
      || endpoints[1].snapshot.revision !== call.input.expected_target_revision
    ) return this.#result(call, target, "precondition_failed", null, [], "fresh_precondition_mismatch");
    if (!RELATION_TYPES.has(call.input.relation_type)) {
      return this.#result(call, target, "not_applied", null, [], "linear_invalid_relation_type");
    }
    const provider = await this.#effect(() => this.client.createRelation({
      id: relationId,
      type: call.input.relation_type,
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    }));
    let after: TaskRelationSnapshot | null;
    try {
      after = await this.#readRelation(call.input.source_issue_id, relationId);
    } catch {
      return this.#result(call, target, "acceptance_unknown", null, [], "fresh_readback_unavailable");
    }
    if (
      after !== null
      && after.type === call.input.relation_type
      && after.source_issue_id === call.input.source_issue_id
      && after.target_issue_id === call.input.target_issue_id
    ) return this.#result(call, target, "applied", after, [{ kind: "relation_added", relation: after }], null);
    return this.#postconditionFailure(call, target, provider, after);
  }

  async #deleteRelation(call: DeleteRelationCall): Promise<DeleteRelationResult> {
    const target = this.#relationTarget(call.input.relation_id, call.input.source_issue_id, call.input.target_issue_id);
    const endpoints = await this.#preconditionEndpoints(call.input.source_issue_id, call.input.target_issue_id);
    if (endpoints === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (
      endpoints[0].snapshot.revision !== call.input.expected_source_revision
      || endpoints[1].snapshot.revision !== call.input.expected_target_revision
    ) return this.#result(call, target, "precondition_failed", null, [], "fresh_precondition_mismatch");
    let before: TaskRelationSnapshot | null;
    try {
      before = await this.#readRelation(call.input.source_issue_id, call.input.relation_id);
    } catch {
      return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    }
    if (
      before === null
      || before.revision !== call.input.expected_relation_revision
      || before.source_issue_id !== call.input.source_issue_id
      || before.target_issue_id !== call.input.target_issue_id
    ) return this.#result(call, target, "precondition_failed", before, [], "fresh_precondition_mismatch");
    const provider = await this.#effect(() => this.client.deleteRelation(call.input.relation_id));
    let after: TaskRelationSnapshot | null;
    try {
      after = await this.#readRelation(call.input.source_issue_id, call.input.relation_id);
    } catch {
      return this.#result(call, target, "acceptance_unknown", null, [], "fresh_readback_unavailable");
    }
    if (after === null) {
      return this.#result(call, target, "applied", null, [{ kind: "relation_removed", relation: before }], null);
    }
    return this.#postconditionFailure(call, target, provider, after);
  }

  async #preconditionIssue(issueId: TaskIssueId): Promise<LinearCommandIssueRecord | null> {
    try {
      return await this.#readIssue(issueId);
    } catch {
      return null;
    }
  }

  async #preconditionEndpoints(
    sourceId: TaskIssueId,
    targetId: TaskIssueId,
  ): Promise<readonly [LinearCommandIssueRecord, LinearCommandIssueRecord] | null> {
    try {
      return await Promise.all([this.#readIssue(sourceId), this.#readIssue(targetId)]);
    } catch {
      return null;
    }
  }

  async #readIssue(issueId: TaskIssueId): Promise<LinearCommandIssueRecord> {
    return assertLinearIssueIdentity(
      parseLinearCommandIssue(await this.client.readIssue(issueId)),
      issueId,
      this.#teamId,
    );
  }

  async #readRelation(issueId: TaskIssueId, relationId: TaskRelationId): Promise<TaskRelationSnapshot | null> {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    let count = 0;
    let found: TaskRelationSnapshot | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page: LinearCommandPage<TaskRelationSnapshot> = parseLinearRelationPage(
        await this.client.listRelations(issueId, cursor, PAGE_SIZE),
        PAGE_SIZE,
      );
      count += page.nodes.length;
      if (count > MAX_NODES) throw new Error("linear_node_limit_exceeded");
      for (const relation of page.nodes) {
        if (relation.source_issue_id !== issueId && relation.target_issue_id !== issueId) {
          throw new Error("linear_relation_identity_mismatch");
        }
        if (relation.relation_id !== relationId) continue;
        if (found !== null) throw new Error("linear_duplicate_relation_identity");
        found = relation;
      }
      if (page.nextCursor === null) return found;
      if (page.nextCursor === cursor || cursors.has(page.nextCursor)) throw new Error("linear_cursor_cycle");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("linear_page_limit_exceeded");
  }

  async #effect(operation: () => Promise<unknown>): Promise<LinearProviderOutcome> {
    try {
      return parseLinearMutationReceipt(await operation());
    } catch {
      return "uncertain";
    }
  }

  #updateInput(desired: UpdateIssueDesired): LinearUpdateIssueInput {
    const input: Record<string, unknown> = {};
    if (desired.title !== undefined) input.title = desired.title;
    if (desired.description !== undefined) input.description = desired.description;
    if (desired.state_id !== undefined) input.state_id = desired.state_id;
    if (desired.parent_id !== undefined) input.parent_issue_id = desired.parent_id;
    if (desired.label_ids !== undefined) input.label_ids = desired.label_ids;
    if (desired.delegate_id !== undefined) input.delegate_id = desired.delegate_id;
    if (desired.priority !== undefined) input.priority = desired.priority;
    return input as LinearUpdateIssueInput;
  }

  #relationTarget(relationId: TaskRelationId, sourceId: TaskIssueId, targetId: TaskIssueId): TaskMutationTarget {
    return Object.freeze({
      kind: "relation",
      relation_id: relationId,
      source_issue_id: sourceId,
      target_issue_id: targetId,
    });
  }

  #postconditionFailure<C extends TaskMcpMutationCall>(
    call: C,
    target: TaskMutationTarget,
    provider: LinearProviderOutcome,
    freshResource: TaskIssueSnapshot | TaskRelationSnapshot | null,
  ): Extract<TaskMcpMutationResult, { readonly function: C["function"] }> {
    if (provider === "uncertain") {
      return this.#result(call, target, "acceptance_unknown", freshResource, [], "provider_acceptance_unknown");
    }
    if (provider === "rejected") {
      return this.#result(call, target, "not_applied", freshResource, [], "provider_rejected");
    }
    return this.#result(call, target, "readback_mismatch", freshResource, [], "fresh_postcondition_mismatch");
  }

  #result<C extends TaskMcpMutationCall>(
    call: C,
    target: TaskMutationTarget,
    outcome: TaskMutationOutput["outcome"],
    freshResource: TaskIssueSnapshot | TaskRelationSnapshot | null,
    concreteDiff: readonly ConcreteTaskChange[],
    reason: string | null,
  ): Extract<TaskMcpMutationResult, { readonly function: C["function"] }> {
    const result = {
      ...resultEnvelope(call),
      output: Object.freeze({
        outcome,
        target,
        fresh_resource: freshResource,
        concrete_diff: Object.freeze(concreteDiff),
        sanitized_reason: reason,
      }),
    };
    return parseTaskMcpResult(result, call) as Extract<TaskMcpMutationResult, { readonly function: C["function"] }>;
  }
}
