import { createHash } from "node:crypto";

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
import type { TaskManageBoundaryExecution } from "../api/TaskManageCommandInterface.js";
import {
  parseTaskMcpResult,
  type ArchiveIssueCall,
  type ArchiveIssueResult,
  type CreateIssueCall,
  type CreateIssueResult,
  type CreateIssueCommentCall,
  type CreateIssueCommentResult,
  type CreateRelationCall,
  type CreateRelationResult,
  type DeleteRelationCall,
  type DeleteRelationResult,
  type TaskMcpMutationCall,
  type TaskMcpMutationResult,
  type TaskMutationOutput,
  type TaskMutationTarget,
  type TaskCommentResource,
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
import type {
  LinearIssueCommentEvidence,
  LinearIssueHistoryEvidence,
} from "./LinearQueries.js";

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

export interface LinearCreateIssueCommentInput {
  readonly id: string;
  readonly issue_id: string;
  readonly body_markdown: string;
}

export interface LinearCommandClient {
  getIssue(issueId: string): Promise<unknown>;
  readIssue(issueId: string): Promise<unknown>;
  listRelations(issueId: string, cursor: string | null, pageSize: number): Promise<unknown>;
  createIssue(input: LinearCreateIssueInput): Promise<unknown>;
  createIssueComment(input: LinearCreateIssueCommentInput): Promise<unknown>;
  updateIssue(issueId: string, input: LinearUpdateIssueInput): Promise<unknown>;
  archiveIssue(issueId: string): Promise<unknown>;
  createRelation(input: LinearCreateRelationInput): Promise<unknown>;
  deleteRelation(relationId: string): Promise<unknown>;
}

export interface LinearCommandOptions {
  readonly team_id: string;
  readonly service_actor_id: string;
}

export interface LinearMutationEvidenceReader {
  readIssueHistory(issueId: TaskIssueId): Promise<readonly LinearIssueHistoryEvidence[]>;
  readIssueComments(issueId: TaskIssueId): Promise<readonly LinearIssueCommentEvidence[]>;
}

interface LinearMutationEvidence {
  readonly history: readonly LinearIssueHistoryEvidence[];
  readonly comments: readonly LinearIssueCommentEvidence[];
}

function resultEnvelope(call: TaskMcpMutationCall | CreateIssueCommentCall) {
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
  readonly #serviceActorId: string;

  constructor(
    private readonly client: LinearCommandClient,
    private readonly evidenceReader: LinearMutationEvidenceReader,
    options: LinearCommandOptions,
  ) {
    this.#teamId = parseBoundedString(options.team_id, "invalid_linear_team_id", 128);
    this.#serviceActorId = parseBoundedString(
      options.service_actor_id,
      "invalid_linear_service_actor_id",
      128,
    );
  }

  execute(call: CreateIssueCall, execution: TaskManageBoundaryExecution): Promise<CreateIssueResult>;
  execute(call: CreateIssueCommentCall, execution: TaskManageBoundaryExecution): Promise<CreateIssueCommentResult>;
  execute(call: UpdateIssueCall, execution: TaskManageBoundaryExecution): Promise<UpdateIssueResult>;
  execute(call: ArchiveIssueCall, execution: TaskManageBoundaryExecution): Promise<ArchiveIssueResult>;
  execute(call: CreateRelationCall, execution: TaskManageBoundaryExecution): Promise<CreateRelationResult>;
  execute(call: DeleteRelationCall, execution: TaskManageBoundaryExecution): Promise<DeleteRelationResult>;
  execute(call: TaskMcpMutationCall, execution: TaskManageBoundaryExecution): Promise<TaskMcpMutationResult>;
  async execute(
    call: TaskMcpMutationCall | CreateIssueCommentCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<TaskMcpMutationResult | CreateIssueCommentResult> {
    switch (call.function) {
      case "create_issue": return this.#createIssue(call, execution);
      case "update_issue": return this.#updateIssue(call, execution);
      case "archive_issue": return this.#archiveIssue(call, execution);
      case "create_issue_comment": return this.#createIssueComment(call, execution);
      case "create_relation": return this.#createRelation(call, execution);
      case "delete_relation": return this.#deleteRelation(call, execution);
    }
  }

  async #createIssueComment(
    call: CreateIssueCommentCall,
    execution: TaskManageBoundaryExecution,
  ): Promise<CreateIssueCommentResult> {
    const issue = await this.#preconditionIssue(call.input.issue_id);
    if (issue === null) return this.#commentResult(call, "not_applied", null, "fresh_precondition_unavailable");
    if (issue.snapshot.revision !== call.input.expected_issue_revision) {
      return this.#commentResult(call, "stale_before_effect", null, "fresh_precondition_mismatch");
    }
    let before: readonly LinearIssueCommentEvidence[];
    try {
      before = await this.evidenceReader.readIssueComments(call.input.issue_id);
      this.#assertUniqueComments(before, call.input.issue_id);
    } catch {
      return this.#commentResult(call, "not_applied", null, "fresh_precondition_unavailable");
    }
    const existing = before.find(({ comment_id }) => comment_id === call.input.comment_id);
    if (existing !== undefined) {
      return this.#commentResult(call, "stale_before_effect", this.#commentResource(existing), "fresh_precondition_mismatch");
    }

    const provider = await this.#effect(execution, () => this.client.createIssueComment({
      id: call.input.comment_id,
      issue_id: call.input.issue_id,
      body_markdown: call.input.body_markdown,
    }));
    let after: readonly LinearIssueCommentEvidence[];
    try {
      after = await this.evidenceReader.readIssueComments(call.input.issue_id);
      this.#assertUniqueComments(after, call.input.issue_id);
    } catch {
      return this.#commentResult(call, "conflict_observed", null, "fresh_readback_unavailable");
    }
    const created = after.find(({ comment_id }) => comment_id === call.input.comment_id);
    const expectedDigest = createHash("sha256").update(call.input.body_markdown, "utf8").digest("hex");
    const exact = created !== undefined
      && created.actor_id === this.#serviceActorId
      && created.provider_archived_at === null
      && created.provider_edited_at === null
      && created.provider_updated_at === created.provider_created_at
      && created.body_digest === expectedDigest
      && this.#onlyExpectedCommentAdded(before, after, call.input.comment_id);
    const fresh = created === undefined ? null : this.#commentResource(created);
    if (exact && provider !== "rejected") return this.#commentResult(call, "applied", fresh, null);
    const reason = provider === "rejected"
      ? "provider_rejected_with_unexpected_readback"
      : created === undefined ? "fresh_postcondition_mismatch" : "unexpected_post_effect_evidence";
    return this.#commentResult(call, "conflict_observed", fresh, reason);
  }

  async #createIssue(call: CreateIssueCall, execution: TaskManageBoundaryExecution): Promise<CreateIssueResult> {
    const issueId = parseTaskIssueId(call.input.issue_id);
    const target: TaskMutationTarget = Object.freeze({ kind: "issue", issue_id: issueId });
    const parent = await this.#preconditionIssue(call.input.parent_issue_id);
    if (parent === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (parent.snapshot.revision !== call.input.expected_parent_revision) {
      return this.#result(call, target, "stale_before_effect", null, [], "fresh_precondition_mismatch");
    }
    let existing: LinearCommandIssueRecord | null;
    try {
      existing = await this.#readOptionalIssue(issueId);
    } catch {
      return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    }
    if (existing !== null) {
      return this.#result(call, target, "stale_before_effect", existing.snapshot, [], "fresh_precondition_mismatch");
    }
    if (call.input.desired.priority !== null && call.input.desired.priority > 4) {
      return this.#result(call, target, "not_applied", null, [], "linear_invalid_priority");
    }
    const provider = await this.#effect(execution, () => this.client.createIssue({
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
    let afterEvidence: LinearMutationEvidence;
    try {
      after = await this.#readIssue(issueId);
      afterEvidence = await this.#readEvidence(issueId);
    } catch {
      return this.#result(call, target, "conflict_observed", null, [], "fresh_readback_unavailable");
    }
    const matches = !after.archived
      && !after.trashed
      && after.creatorId === this.#serviceActorId
      && after.snapshot.parent_id === call.input.parent_issue_id
      && linearIssueMatches(after.snapshot, {
        title: call.input.desired.title,
        description: call.input.desired.description,
        state_id: call.input.desired.state_id,
        label_ids: call.input.desired.label_ids,
        delegate_id: call.input.desired.delegate_id,
        priority: call.input.desired.priority,
      });
    const evidenceMatches = !this.#hasUnexpectedEvidence(
      Object.freeze({ history: [], comments: [] }),
      afterEvidence,
    );
    if (matches && evidenceMatches && provider !== "rejected") {
      return this.#result(call, target, "applied", after.snapshot, [{ kind: "issue_created", issue: after.snapshot }], null);
    }
    if (matches && !evidenceMatches) {
      return this.#result(
        call,
        target,
        "conflict_observed",
        after.snapshot,
        [{ kind: "issue_created", issue: after.snapshot }],
        "unexpected_post_effect_evidence",
      );
    }
    return this.#postconditionFailure(call, target, provider, after.snapshot);
  }

  async #updateIssue(call: UpdateIssueCall, execution: TaskManageBoundaryExecution): Promise<UpdateIssueResult> {
    const target: TaskMutationTarget = Object.freeze({ kind: "issue", issue_id: call.input.issue_id });
    const before = await this.#preconditionIssue(call.input.issue_id);
    if (before === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (before.snapshot.revision !== call.input.expected_revision) {
      return this.#result(call, target, "stale_before_effect", before.snapshot, [], "fresh_precondition_mismatch");
    }
    let beforeEvidence: LinearMutationEvidence;
    try {
      beforeEvidence = await this.#readEvidence(call.input.issue_id);
    } catch {
      return this.#result(call, target, "not_applied", before.snapshot, [], "fresh_precondition_unavailable");
    }
    if (call.input.desired.priority !== undefined && call.input.desired.priority !== null && call.input.desired.priority > 4) {
      return this.#result(call, target, "not_applied", before.snapshot, [], "linear_invalid_priority");
    }
    if (linearIssueMatches(before.snapshot, call.input.desired)) {
      return this.#result(call, target, "not_applied", before.snapshot, [], "desired_state_already_present");
    }
    const provider = await this.#effect(
      execution,
      () => this.client.updateIssue(call.input.issue_id, this.#updateInput(call.input.desired)),
    );
    let after: LinearCommandIssueRecord;
    let afterEvidence: LinearMutationEvidence;
    try {
      after = await this.#readIssue(call.input.issue_id);
      afterEvidence = await this.#readEvidence(call.input.issue_id);
    } catch {
      return this.#result(call, target, "conflict_observed", null, [], "fresh_readback_unavailable");
    }
    if (provider !== "rejected" && !after.archived && linearIssueMatches(after.snapshot, call.input.desired)) {
      const changes = taskIssueChanges(before.snapshot, after.snapshot);
      if (this.#hasUnexpectedEvidence(beforeEvidence, afterEvidence)) {
        return this.#result(
          call,
          target,
          "conflict_observed",
          after.snapshot,
          changes,
          "unexpected_post_effect_evidence",
        );
      }
      if (changes.length === 1) return this.#result(call, target, "applied", after.snapshot, changes, null);
      if (changes.length > 1) {
        return this.#result(call, target, "conflict_observed", after.snapshot, changes, "unexpected_post_effect_delta");
      }
    }
    return this.#postconditionFailure(call, target, provider, after.snapshot, before.snapshot);
  }

  async #archiveIssue(call: ArchiveIssueCall, execution: TaskManageBoundaryExecution): Promise<ArchiveIssueResult> {
    const target: TaskMutationTarget = Object.freeze({ kind: "issue", issue_id: call.input.issue_id });
    const before = await this.#preconditionIssue(call.input.issue_id);
    if (before === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (before.snapshot.revision !== call.input.expected_revision) {
      return this.#result(call, target, "stale_before_effect", before.snapshot, [], "fresh_precondition_mismatch");
    }
    let beforeEvidence: LinearMutationEvidence;
    try {
      beforeEvidence = await this.#readEvidence(call.input.issue_id);
    } catch {
      return this.#result(call, target, "not_applied", before.snapshot, [], "fresh_precondition_unavailable");
    }
    if (before.archived) return this.#result(call, target, "not_applied", before.snapshot, [], "desired_state_already_present");
    const provider = await this.#effect(execution, () => this.client.archiveIssue(call.input.issue_id));
    let after: LinearCommandIssueRecord;
    let afterEvidence: LinearMutationEvidence;
    try {
      after = await this.#readIssue(call.input.issue_id);
      afterEvidence = await this.#readEvidence(call.input.issue_id);
    } catch {
      return this.#result(call, target, "conflict_observed", null, [], "fresh_readback_unavailable");
    }
    const unexpectedEvidence = this.#hasUnexpectedEvidence(beforeEvidence, afterEvidence);
    if (provider !== "rejected" && after.archived && !unexpectedEvidence) {
      return this.#result(call, target, "applied", after.snapshot, [{ kind: "issue_archived", issue: after.snapshot }], null);
    }
    if (after.archived && unexpectedEvidence) {
      return this.#result(
        call,
        target,
        "conflict_observed",
        after.snapshot,
        [{ kind: "issue_archived", issue: after.snapshot }],
        "unexpected_post_effect_evidence",
      );
    }
    return this.#postconditionFailure(call, target, provider, after.snapshot);
  }

  async #createRelation(call: CreateRelationCall, execution: TaskManageBoundaryExecution): Promise<CreateRelationResult> {
    const relationId = parseTaskRelationId(call.input.relation_id);
    const target = this.#relationTarget(relationId, call.input.source_issue_id, call.input.target_issue_id);
    const endpoints = await this.#preconditionEndpoints(call.input.source_issue_id, call.input.target_issue_id);
    if (endpoints === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (
      endpoints[0].snapshot.revision !== call.input.expected_source_revision
      || endpoints[1].snapshot.revision !== call.input.expected_target_revision
    ) return this.#result(call, target, "stale_before_effect", null, [], "fresh_precondition_mismatch");
    if (!RELATION_TYPES.has(call.input.relation_type)) {
      return this.#result(call, target, "not_applied", null, [], "linear_invalid_relation_type");
    }
    let existing: TaskRelationSnapshot | null;
    try {
      existing = await this.#readRelation(call.input.source_issue_id, relationId);
    } catch {
      return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    }
    if (existing !== null) {
      return this.#result(call, target, "stale_before_effect", existing, [], "fresh_precondition_mismatch");
    }
    let beforeEvidence: readonly [LinearMutationEvidence, LinearMutationEvidence];
    try {
      beforeEvidence = await this.#readEndpointEvidence(call.input.source_issue_id, call.input.target_issue_id);
    } catch {
      return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    }
    const provider = await this.#effect(execution, () => this.client.createRelation({
      id: relationId,
      type: call.input.relation_type,
      source_issue_id: call.input.source_issue_id,
      target_issue_id: call.input.target_issue_id,
    }));
    let after: TaskRelationSnapshot | null;
    let afterEvidence: readonly [LinearMutationEvidence, LinearMutationEvidence];
    try {
      after = await this.#readRelation(call.input.source_issue_id, relationId);
      afterEvidence = await this.#readEndpointEvidence(call.input.source_issue_id, call.input.target_issue_id);
    } catch {
      return this.#result(call, target, "conflict_observed", null, [], "fresh_readback_unavailable");
    }
    const unexpectedEvidence = this.#hasUnexpectedEndpointEvidence(beforeEvidence, afterEvidence);
    if (
      provider !== "rejected"
      && after !== null
      && after.type === call.input.relation_type
      && after.source_issue_id === call.input.source_issue_id
      && after.target_issue_id === call.input.target_issue_id
      && !unexpectedEvidence
    ) return this.#result(call, target, "applied", after, [{ kind: "relation_added", relation: after }], null);
    if (after !== null && unexpectedEvidence) {
      return this.#result(
        call,
        target,
        "conflict_observed",
        after,
        [{ kind: "relation_added", relation: after }],
        "unexpected_post_effect_evidence",
      );
    }
    return this.#postconditionFailure(call, target, provider, after);
  }

  async #deleteRelation(call: DeleteRelationCall, execution: TaskManageBoundaryExecution): Promise<DeleteRelationResult> {
    const target = this.#relationTarget(call.input.relation_id, call.input.source_issue_id, call.input.target_issue_id);
    const endpoints = await this.#preconditionEndpoints(call.input.source_issue_id, call.input.target_issue_id);
    if (endpoints === null) return this.#result(call, target, "not_applied", null, [], "fresh_precondition_unavailable");
    if (
      endpoints[0].snapshot.revision !== call.input.expected_source_revision
      || endpoints[1].snapshot.revision !== call.input.expected_target_revision
    ) return this.#result(call, target, "stale_before_effect", null, [], "fresh_precondition_mismatch");
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
    ) return this.#result(call, target, "stale_before_effect", before, [], "fresh_precondition_mismatch");
    let beforeEvidence: readonly [LinearMutationEvidence, LinearMutationEvidence];
    try {
      beforeEvidence = await this.#readEndpointEvidence(call.input.source_issue_id, call.input.target_issue_id);
    } catch {
      return this.#result(call, target, "not_applied", before, [], "fresh_precondition_unavailable");
    }
    const provider = await this.#effect(execution, () => this.client.deleteRelation(call.input.relation_id));
    let after: TaskRelationSnapshot | null;
    let afterEvidence: readonly [LinearMutationEvidence, LinearMutationEvidence];
    try {
      after = await this.#readRelation(call.input.source_issue_id, call.input.relation_id);
      afterEvidence = await this.#readEndpointEvidence(call.input.source_issue_id, call.input.target_issue_id);
    } catch {
      return this.#result(call, target, "conflict_observed", null, [], "fresh_readback_unavailable");
    }
    const unexpectedEvidence = this.#hasUnexpectedEndpointEvidence(beforeEvidence, afterEvidence);
    if (
      provider !== "rejected"
      && after === null
      && !unexpectedEvidence
    ) {
      return this.#result(call, target, "applied", null, [{ kind: "relation_removed", relation: before }], null);
    }
    if (after === null && unexpectedEvidence) {
      return this.#result(
        call,
        target,
        "conflict_observed",
        null,
        [{ kind: "relation_removed", relation: before }],
        "unexpected_post_effect_evidence",
      );
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

  async #readOptionalIssue(issueId: TaskIssueId): Promise<LinearCommandIssueRecord | null> {
    const value = await this.client.getIssue(issueId);
    return value === null ? null : assertLinearIssueIdentity(parseLinearCommandIssue(value), issueId, this.#teamId);
  }

  async #readEvidence(issueId: TaskIssueId): Promise<LinearMutationEvidence> {
    const [history, comments] = await Promise.all([
      this.evidenceReader.readIssueHistory(issueId),
      this.evidenceReader.readIssueComments(issueId),
    ]);
    return Object.freeze({ history, comments });
  }

  #readEndpointEvidence(
    sourceIssueId: TaskIssueId,
    targetIssueId: TaskIssueId,
  ): Promise<readonly [LinearMutationEvidence, LinearMutationEvidence]> {
    return Promise.all([this.#readEvidence(sourceIssueId), this.#readEvidence(targetIssueId)]);
  }

  #hasUnexpectedEndpointEvidence(
    before: readonly [LinearMutationEvidence, LinearMutationEvidence],
    after: readonly [LinearMutationEvidence, LinearMutationEvidence],
  ): boolean {
    return this.#hasUnexpectedEvidence(before[0], after[0])
      || this.#hasUnexpectedEvidence(before[1], after[1]);
  }

  #hasUnexpectedEvidence(before: LinearMutationEvidence, after: LinearMutationEvidence): boolean {
    const beforeHistory = new Map(before.history.map((entry) => [entry.history_id, JSON.stringify(entry)]));
    const afterHistory = new Map(after.history.map((entry) => [entry.history_id, entry]));
    for (const [identity, value] of beforeHistory) {
      const observed = afterHistory.get(identity);
      if (observed === undefined || JSON.stringify(observed) !== value) return true;
    }
    for (const entry of after.history) {
      if (!beforeHistory.has(entry.history_id) && entry.change_origin !== "symphony") return true;
    }
    const beforeComments = new Map(before.comments.map((entry) => [entry.comment_id, JSON.stringify(entry)]));
    if (beforeComments.size !== after.comments.length) return true;
    return after.comments.some((entry) => beforeComments.get(entry.comment_id) !== JSON.stringify(entry));
  }

  #assertUniqueComments(comments: readonly LinearIssueCommentEvidence[], issueId: TaskIssueId): void {
    const ids = new Set<string>();
    for (const comment of comments) {
      if (comment.issue_id !== issueId || ids.has(comment.comment_id)) throw new Error("linear_comment_identity_mismatch");
      ids.add(comment.comment_id);
    }
  }

  #onlyExpectedCommentAdded(
    before: readonly LinearIssueCommentEvidence[],
    after: readonly LinearIssueCommentEvidence[],
    commentId: string,
  ): boolean {
    if (after.length !== before.length + 1) return false;
    const afterById = new Map(after.map((comment) => [comment.comment_id, JSON.stringify(comment)]));
    return before.every((comment) => afterById.get(comment.comment_id) === JSON.stringify(comment))
      && after.filter((comment) => comment.comment_id === commentId).length === 1;
  }

  #commentResource(comment: LinearIssueCommentEvidence): TaskCommentResource {
    return Object.freeze({ ...comment, issue_id: parseTaskIssueId(comment.issue_id) });
  }

  #commentResult(
    call: CreateIssueCommentCall,
    outcome: CreateIssueCommentResult["output"]["outcome"],
    freshComment: TaskCommentResource | null,
    reason: string | null,
  ): CreateIssueCommentResult {
    return parseTaskMcpResult({
      ...resultEnvelope(call),
      output: Object.freeze({
        outcome,
        effect_may_have_occurred: outcome === "applied" || outcome === "conflict_observed",
        target: Object.freeze({
          kind: "comment",
          comment_id: call.input.comment_id,
          issue_id: call.input.issue_id,
        }),
        fresh_comment: freshComment,
        sanitized_reason: reason,
      }),
    }, call);
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

  async #effect(
    execution: TaskManageBoundaryExecution,
    operation: () => Promise<unknown>,
  ): Promise<LinearProviderOutcome> {
    execution.assertActive();
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
    beforeResource: TaskIssueSnapshot | TaskRelationSnapshot | null = null,
  ): Extract<TaskMcpMutationResult, { readonly function: C["function"] }> {
    if (
      provider === "rejected"
      && freshResource !== null
      && beforeResource !== null
      && freshResource.revision === beforeResource.revision
    ) return this.#result(call, target, "not_applied", freshResource, [], "provider_rejected");
    const reason = provider === "uncertain"
      ? "provider_acceptance_unknown"
      : provider === "rejected" ? "provider_rejected_with_unexpected_readback" : "fresh_postcondition_mismatch";
    return this.#result(call, target, "conflict_observed", freshResource, [], reason);
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
        effect_may_have_occurred: outcome === "applied" || outcome === "conflict_observed",
        target,
        fresh_resource: freshResource,
        concrete_diff: Object.freeze(concreteDiff),
        sanitized_reason: reason,
      }),
    };
    return parseTaskMcpResult(result, call) as Extract<TaskMcpMutationResult, { readonly function: C["function"] }>;
  }
}
