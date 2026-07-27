import type { ProtocolError } from "../errors.js";
import type { LinearClientInterface } from "./api/LinearClientInterface.js";
import { classifyLinearFailure } from "./LinearFailure.js";
import { isTargetWorkflowStatusName } from "../../public/TargetWorkflowCatalog.js";
import type {
  WorkflowMutationCommand,
  WorkflowMutationResult,
  WorkflowCommentValue,
  RootHeaderValue,
} from "./types.js";

interface RetryOptions {
  sleep(delayMs: number): Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  random?: () => number;
}

const MAX_TREE_NODES = 512;

function errorRecord(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

function normalizedFailure(error: unknown): {
  code: string;
  sanitizedReason: string;
} {
  const official = classifyLinearFailure(error);
  if (official) return official;
  if (
    error instanceof Error &&
    /^linear_[a-z0-9_]{1,119}$/.test(error.message)
  ) {
    return { code: error.message, sanitizedReason: error.message };
  }
  return {
    code: "linear_request_failed",
    sanitizedReason: "Linear request failed.",
  };
}

function protocolFailure(error: unknown): ProtocolError {
  const normalized = normalizedFailure(error);
  const classified = classifyLinearFailure(error);
  return {
    code: normalized.code,
    category: "linear",
    sanitizedReason: normalized.sanitizedReason,
    retryable: classified?.retryable ?? false,
    actionRequired: "block_root",
    nextAction: "Resolve the Linear error, then retry the Root.",
  };
}

export class LinearGatewayProtocolHandlerImpl {
  private readonly projectResolutionCache = new Map<string, ReturnType<LinearClientInterface["readProjectResolution"]>>();

  constructor(
    private readonly client: LinearClientInterface,
    private readonly retry: RetryOptions,
  ) {
    if (
      !Number.isInteger(retry.maxAttempts) ||
      retry.maxAttempts < 1 ||
      retry.maxAttempts > 10 ||
      !Number.isFinite(retry.baseDelayMs) ||
      retry.baseDelayMs < 1 ||
      retry.baseDelayMs > 60_000
    ) {
      throw new Error("linear_retry_policy_invalid");
    }
  }

  async resolveProject(conductorShortHash: string) {
    if (!identifier(conductorShortHash, 128)) {
      throw new Error("linear_conductor_short_hash_invalid");
    }
    return this.readProjectResolution(conductorShortHash);
  }

  async listProjectRootIndexPage(input: {
    projectId: string;
    cursor?: string;
    limit: number;
  }) {
    const page = await this.client.listProjectRootIndexPage(input);
    if (page.headers.length > input.limit) {
      throw new Error("linear_project_root_index_page_too_large");
    }
    const rootIssueIds = new Set<string>();
    for (const header of page.headers) {
      validateRootHeader(header, input.projectId, rootIssueIds);
    }
    nextCursor(page.pageInfo);
    return page;
  }

  async getWorkflowIssueTree(projectId: string, rootIssueId: string) {
    const tree = await this.client.getWorkflowIssueTree({ projectId, rootIssueId });
    if (
      tree.rootIssueId !== rootIssueId ||
      !timestamp(tree.observedAt) ||
      tree.statusCatalog.length === 0 ||
      tree.statusCatalog.length > 64 ||
      tree.issues.length === 0 ||
      tree.issues.length > MAX_TREE_NODES ||
      tree.comments.length > 4_096 ||
      tree.relations.length > 1_024 ||
      tree.attachments.length > 1_024 ||
      tree.activities.length > 8_192
    ) {
      throw new Error("linear_workflow_tree_invalid");
    }
    const statusIds = new Set<string>();
    const statusNames = new Set<string>();
    const statusById = new Map<string, (typeof tree.statusCatalog)[number]>();
    for (const status of tree.statusCatalog) {
      if (
        !identifier(status.statusId, 128) ||
        !shortText(status.name) ||
        !workflowStatusCategory(status.category) ||
        !Number.isFinite(status.position) ||
        statusIds.has(status.statusId) ||
        statusNames.has(status.name)
      ) {
        throw new Error("linear_workflow_status_catalog_invalid");
      }
      statusIds.add(status.statusId);
      statusNames.add(status.name);
      statusById.set(status.statusId, status);
    }
    const issueIds = new Set<string>();
    for (const issue of tree.issues) {
      if (
        !identifier(issue.issueId, 128) ||
        !shortText(issue.identifier) ||
        issue.projectId !== projectId ||
        !statusIds.has(issue.statusId) ||
        !shortText(issue.statusName) ||
        !workflowStatusCategory(issue.statusCategory) ||
        !Number.isFinite(issue.statusPosition) ||
        !Number.isFinite(issue.order) ||
        !Number.isInteger(issue.depth) ||
        issue.depth < 0 ||
        issue.depth > 32 ||
        !shortText(issue.title) ||
        !boundedText(issue.description) ||
        !Array.isArray(issue.labels) ||
        issue.labels.length > 64 ||
        issue.labels.some((label) => !shortText(label)) ||
        new Set(issue.labels).size !== issue.labels.length ||
        !identifier(issue.remoteVersion, 512) ||
        !timestamp(issue.createdAt) ||
        !timestamp(issue.updatedAt) ||
        (issue.parentIssueId !== undefined &&
          (!identifier(issue.parentIssueId, 128) || issue.parentIssueId === issue.issueId)) ||
        issueIds.has(issue.issueId)
      ) {
        throw new Error("linear_workflow_issue_invalid");
      }
      const status = statusById.get(issue.statusId);
      if (
        !status ||
        issue.statusName !== status.name ||
        issue.statusCategory !== status.category ||
        issue.statusPosition !== status.position
      ) {
        throw new Error("linear_workflow_issue_status_invalid");
      }
      issueIds.add(issue.issueId);
    }
    if (!issueIds.has(rootIssueId)) throw new Error("linear_workflow_root_missing");
    const root = tree.issues.find(({ issueId }) => issueId === rootIssueId);
    if (!root || root.depth !== 0 || root.parentIssueId !== undefined) {
      throw new Error("linear_workflow_root_invalid");
    }
    for (const issue of tree.issues) {
      if (issue.parentIssueId !== undefined && !issueIds.has(issue.parentIssueId)) {
        throw new Error("linear_workflow_parent_invalid");
      }
    }
    const commentIds = new Set<string>();
    for (const comment of tree.comments) {
      if (
        !identifier(comment.commentId, 128) ||
        !issueIds.has(comment.issueId) ||
        !boundedText(comment.body) ||
        !workflowCommentAuthorKind(comment.authorKind) ||
        !identifier(comment.authorId, 128) ||
        (comment.authorUserId !== undefined && !identifier(comment.authorUserId, 128)) ||
        (comment.parentCommentId !== undefined &&
          (!identifier(comment.parentCommentId, 128) || comment.parentCommentId === comment.commentId)) ||
        !identifier(comment.threadRootCommentId, 128) ||
        !workflowCommentThreadState(comment.threadState) ||
        !Array.isArray(comment.reactions) ||
        comment.reactions.length > 256 ||
        !timestamp(comment.createdAt) ||
        !identifier(comment.remoteVersion, 512) ||
        !timestamp(comment.updatedAt) ||
        commentIds.has(comment.commentId)
      ) {
        throw new Error("linear_workflow_comment_invalid");
      }
      commentIds.add(comment.commentId);
      const reactionIds = new Set<string>();
      for (const reaction of comment.reactions) {
        if (
          !identifier(reaction.reactionId, 128) ||
          !shortText(reaction.emoji) ||
          !workflowCommentAuthorKind(reaction.actorKind) ||
          !identifier(reaction.actorId, 128) ||
          reactionIds.has(reaction.reactionId)
        ) {
          throw new Error("linear_workflow_comment_reaction_invalid");
        }
        reactionIds.add(reaction.reactionId);
      }
    }
    for (const comment of tree.comments) {
      if (
        (comment.parentCommentId === undefined && comment.threadRootCommentId !== comment.commentId) ||
        (comment.parentCommentId !== undefined &&
          (!commentIds.has(comment.parentCommentId) || !commentIds.has(comment.threadRootCommentId)))
      ) {
        throw new Error("linear_workflow_comment_thread_invalid");
      }
    }
    const relationIds = new Set<string>();
    for (const relation of tree.relations) {
      if (
        !identifier(relation.relationId, 128) ||
        !workflowRelationKind(relation.relationKind) ||
        !issueIds.has(relation.sourceIssueId) ||
        !issueIds.has(relation.targetIssueId) ||
        relation.sourceIssueId === relation.targetIssueId ||
        relationIds.has(relation.relationId)
      ) {
        throw new Error("linear_workflow_relation_invalid");
      }
      relationIds.add(relation.relationId);
    }
    const attachmentIds = new Set<string>();
    for (const attachment of tree.attachments) {
      if (!identifier(attachment.attachmentId, 128) || !issueIds.has(attachment.issueId) ||
          !boundedText(attachment.title) || !boundedText(attachment.url) || !shortText(attachment.sourceType) ||
          !identifier(attachment.remoteVersion, 512) || !timestamp(attachment.createdAt) ||
          !timestamp(attachment.updatedAt) || attachmentIds.has(attachment.attachmentId)) {
        throw new Error("linear_workflow_attachment_invalid");
      }
      attachmentIds.add(attachment.attachmentId);
    }
    const activityIds = new Set<string>();
    for (const activity of tree.activities) {
      if (!identifier(activity.activityId, 128) || !issueIds.has(activity.issueId) ||
          !Array.isArray(activity.activityKinds) || activity.activityKinds.length === 0 ||
          activity.activityKinds.length > 7 || new Set(activity.activityKinds).size !== activity.activityKinds.length ||
          activity.activityKinds.some((kind) => !workflowActivityKind(kind)) ||
          !workflowCommentAuthorKind(activity.actorKind) ||
          (activity.actorId !== undefined && !identifier(activity.actorId, 128)) ||
          !workflowActivityReferencesValid(activity) || !identifier(activity.remoteVersion, 512) ||
          !timestamp(activity.createdAt) || activityIds.has(activity.activityId)) {
        throw new Error("linear_workflow_activity_invalid");
      }
      activityIds.add(activity.activityId);
    }
    validateWorkflowSourceFacts(tree, projectId);
    return tree;
  }

  async mutateWorkflow(
    command: WorkflowMutationCommand,
  ): Promise<WorkflowMutationResult> {
    let readBackBeforeRetry = false;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      let mutationAttempted = false;
      try {
        if (readBackBeforeRetry) {
          const outcome = await this.client.readWorkflowMutationOutcome(command);
          if (outcome) return { kind: "already_applied", readBack: outcome };
          readBackBeforeRetry = false;
        }
        if (this.client.preflightWorkflowMutation) {
          const preflight = await this.client.preflightWorkflowMutation(command);
          if (preflight.kind === "already_applied") {
            return { kind: "already_applied", readBack: preflight.readBack };
          }
          if (preflight.kind === "precondition_conflict") {
            return { kind: "precondition_conflict" };
          }
        } else {
          const idempotentOutcome = await this.#checkWorkflowIdempotentOutcome(command);
          if (idempotentOutcome) return idempotentOutcome;
          const preconditionFailure = await this.#checkWorkflowPreconditions(command);
          if (preconditionFailure) return preconditionFailure;
        }
        mutationAttempted = true;
        await this.client.executeWorkflowMutation(command);
        const readBack = await this.client.readWorkflowMutationOutcome(command);
        if (!readBack) {
          const error = new Error("linear_workflow_mutation_read_back_mismatch") as Error & {
            retryable: boolean;
            ambiguous: boolean;
          };
          error.retryable = true;
          error.ambiguous = true;
          throw error;
        }
        return { kind: "applied", readBack };
      } catch (error) {
        const record = errorRecord(error);
        if (record.preconditionConflict === true) {
          return { kind: "precondition_conflict" };
        }
        const classified = classifyLinearFailure(error);
        const isRetryable = record.retryable === true || classified?.retryable === true;
        const isAmbiguous = record.ambiguous === true || classified?.ambiguous === true;
        if (isAmbiguous && mutationAttempted) {
          readBackBeforeRetry = true;
          try {
            const outcome = await this.client.readWorkflowMutationOutcome(command);
            if (outcome) return { kind: "already_applied", readBack: outcome };
          } catch {
            if (attempt === this.retry.maxAttempts) {
              return this.#workflowWriteUnconfirmed(command, error);
            }
          }
          if (attempt === this.retry.maxAttempts) {
            return this.#workflowWriteUnconfirmed(command, error);
          }
        }
        if (!isRetryable || attempt === this.retry.maxAttempts) {
          return { kind: "failed", error: protocolFailure(error) };
        }
        const retryAfterMs = typeof record.retryAfterMs === "number" &&
          Number.isFinite(record.retryAfterMs) && record.retryAfterMs >= 0
          ? record.retryAfterMs : 0;
        const exponential = this.retry.baseDelayMs * 2 ** (attempt - 1);
        const jitter = this.retry.random
          ? Math.floor(exponential * 0.25 * this.retry.random()) : 0;
        await this.retry.sleep(Math.min(
          this.retry.maxDelayMs ?? 60_000,
          Math.max(retryAfterMs, exponential) + jitter,
        ));
      }
    }
    return { kind: "failed", error: protocolFailure(new Error("Linear retry exhausted.")) };
  }

  async #checkWorkflowIdempotentOutcome(
    command: WorkflowMutationCommand,
  ): Promise<
    | Extract<WorkflowMutationResult, { kind: "already_applied" }>
    | Extract<WorkflowMutationResult, { kind: "precondition_conflict" }>
    | undefined
  > {
    const projectFailure = await this.#checkWorkflowProject(command);
    if (projectFailure) return projectFailure;
    const outcome = await this.client.readWorkflowMutationOutcome(command);
    return outcome ? { kind: "already_applied", readBack: outcome } : undefined;
  }

  async #checkWorkflowPreconditions(
    command: WorkflowMutationCommand,
  ): Promise<Extract<WorkflowMutationResult, { kind: "precondition_conflict" }> | undefined> {
    const projectFailure = await this.#checkWorkflowProject(command);
    if (projectFailure) return projectFailure;
    const root = await this.client.readWorkflowMutationTarget(command.rootIssueId);
    if (!workflowTargetMatches(root, command.expectedProjectId, command.rootIssueId, command.expectedRootRemoteVersion)) {
      return { kind: "precondition_conflict" };
    }
    if (isNativeCommentMutation(command)) {
      const tree = await this.getWorkflowIssueTree(command.expectedProjectId, command.rootIssueId);
      return nativeCommentPreconditionsMatch(command, tree.comments)
        ? undefined
        : { kind: "precondition_conflict" };
    }
    if (command.kind === "create_workflow_issue") {
      const parent = await this.client.readWorkflowMutationTarget(command.parentIssueId);
      return workflowTargetMatches(
        parent,
        command.expectedProjectId,
        command.parentIssueId,
        command.parentExpectedRemoteVersion,
      ) && parent?.statusId === command.parentExpectedStatusId
        ? undefined : { kind: "precondition_conflict" };
    }
    if (command.kind === "create_workflow_relation") {
      const source = await this.client.readWorkflowMutationTarget(command.sourceIssueId);
      const target = await this.client.readWorkflowMutationTarget(command.targetIssueId);
      return workflowTargetMatches(source, command.expectedProjectId, command.sourceIssueId, command.sourceExpectedRemoteVersion) &&
        workflowTargetMatches(target, command.expectedProjectId, command.targetIssueId, command.targetExpectedRemoteVersion)
        ? undefined : { kind: "precondition_conflict" };
    }
    const target = await this.client.readWorkflowMutationTarget(command.target.targetIssueId);
    return workflowTargetMatches(
      target,
      command.expectedProjectId,
      command.target.targetIssueId,
      command.target.expectedRemoteVersion,
    ) &&
      (command.target.expectedStatusId === undefined || target?.statusId === command.target.expectedStatusId) &&
      (command.target.expectedParentIssueId === undefined || target?.parentIssueId === command.target.expectedParentIssueId) &&
      (command.target.expectedIsArchived === undefined || target?.isArchived === command.target.expectedIsArchived)
      ? undefined : { kind: "precondition_conflict" };
  }

  async #checkWorkflowProject(
    command: WorkflowMutationCommand,
  ): Promise<Extract<WorkflowMutationResult, { kind: "precondition_conflict" }> | undefined> {
    const resolution = await this.readProjectResolution(command.conductorShortHash);
    return resolution.kind === "resolved" &&
      resolution.projectId === command.expectedProjectId
      ? undefined : { kind: "precondition_conflict" };
  }

  async #workflowWriteUnconfirmed(
    command: WorkflowMutationCommand,
    error: unknown,
  ): Promise<WorkflowMutationResult> {
    try {
      const issueId = workflowReadBackIssueId(command);
      const target = await this.client.readWorkflowMutationTarget(issueId);
      if (!target) throw new Error("linear_workflow_read_back_target_missing");
      return {
        kind: "write_unconfirmed",
        readBackTarget: {
          writeId: command.writeId,
          targetIssueId: target.issueId,
          remoteVersion: target.updatedAt,
        },
      };
    } catch {
      return { kind: "failed", error: protocolFailure(error) };
    }
  }

  private async readProjectResolution(conductorShortHash: string) {
    const cached = this.projectResolutionCache.get(conductorShortHash);
    if (cached) return cached;
    const pending = this.client.readProjectResolution({ conductorShortHash }).catch((error) => {
      this.projectResolutionCache.delete(conductorShortHash);
      throw error;
    });
    this.projectResolutionCache.set(conductorShortHash, pending);
    return pending;
  }
}

function workflowTargetMatches(
  target: Awaited<ReturnType<LinearClientInterface["readWorkflowMutationTarget"]>>,
  projectId: string,
  issueId: string,
  updatedAt: string,
): boolean {
  return target?.projectId === projectId && target.issueId === issueId && target.updatedAt === updatedAt;
}

function workflowReadBackIssueId(command: WorkflowMutationCommand): string {
  if (isNativeCommentMutation(command)) return command.rootIssueId;
  if (command.kind === "create_workflow_issue") return command.parentIssueId;
  if (command.kind === "create_workflow_relation") return command.sourceIssueId;
  return command.target.targetIssueId;
}

type NativeCommentMutation = Extract<WorkflowMutationCommand, {
  kind: "create_comment_reply" | "set_comment_receipt_reaction" | "set_comment_thread_state";
}>;

function isNativeCommentMutation(command: WorkflowMutationCommand): command is NativeCommentMutation {
  return command.kind === "create_comment_reply" ||
    command.kind === "set_comment_receipt_reaction" ||
    command.kind === "set_comment_thread_state";
}

function nativeCommentPreconditionsMatch(
  command: NativeCommentMutation,
  comments: readonly WorkflowCommentValue[],
): boolean {
  const byId = new Map(comments.map((comment) => [comment.commentId, comment]));
  switch (command.kind) {
    case "create_comment_reply": {
      const source = byId.get(command.sourceCommentId);
      return source?.remoteVersion === command.expectedSourceCommentRemoteVersion &&
        source.threadRootCommentId === command.expectedThreadRootCommentId &&
        source.threadState === command.expectedThreadState;
    }
    case "set_comment_receipt_reaction": {
      const source = byId.get(command.sourceCommentId);
      return source?.remoteVersion === command.expectedSourceCommentRemoteVersion &&
        source.threadRootCommentId === command.threadRootCommentId &&
        symphonyReceipt(source) === command.expectedReceipt;
    }
    case "set_comment_thread_state": {
      const source = byId.get(command.sourceCommentId);
      return source?.remoteVersion === command.expectedSourceCommentRemoteVersion &&
        source.threadRootCommentId === command.threadRootCommentId &&
        source.threadState === command.expectedThreadState;
    }
  }
}

function symphonyReceipt(comment: WorkflowCommentValue): "check" | "cross" | "none" {
  const receipts = comment.reactions.filter((reaction) =>
    reaction.actorKind === "symphony" &&
    (reaction.emoji === "✅" || reaction.emoji === "❌"),
  );
  if (receipts.length > 1) throw new Error("linear_workflow_receipt_ambiguous");
  return receipts[0]?.emoji === "✅" ? "check" : receipts[0]?.emoji === "❌" ? "cross" : "none";
}

function nextCursor(pageInfo: { hasNextPage: boolean; endCursor?: string }): string | undefined {
  if (!pageInfo.hasNextPage) return undefined;
  if (!pageInfo.endCursor) throw new Error("linear_pagination_cursor_missing");
  return pageInfo.endCursor;
}

function validateRootHeader(
  root: RootHeaderValue,
  projectId: string,
  rootIssueIds: Set<string>,
): void {
  if (
    !identifier(root.rootIssueId, 128) ||
    rootIssueIds.has(root.rootIssueId) ||
    !shortText(root.identifier) ||
    root.projectId !== projectId ||
    !linearIssueState(root.state) ||
    typeof root.isArchived !== "boolean" ||
    !timestamp(root.updatedAt) ||
    typeof root.isDelegatedToSymphony !== "boolean" ||
    !linearPriority(root.priority) ||
    !Array.isArray(root.blockers) ||
    root.blockers.length > 250 ||
    !Array.isArray(root.rootConductorLabels) ||
    root.rootConductorLabels.length > 1
  ) {
    throw new Error("linear_project_root_index_invalid");
  }
  rootIssueIds.add(root.rootIssueId);
  const rootConductorHashes = new Set<string>();
  for (const entry of root.rootConductorLabels) {
    if (
      !identifier(entry.conductorShortHash, 128) ||
      rootConductorHashes.has(entry.conductorShortHash)
    ) {
      throw new Error("linear_project_root_index_invalid");
    }
    rootConductorHashes.add(entry.conductorShortHash);
  }
  for (const blocker of root.blockers) {
    const value = errorRecord(blocker);
    if (
      value.sourceIssueId !== root.rootIssueId ||
      typeof value.targetIssueId !== "string" ||
      !identifier(value.targetIssueId, 128) ||
      value.targetIssueId === root.rootIssueId ||
      typeof value.targetState !== "string" ||
      !linearIssueState(value.targetState)
    ) {
      throw new Error("linear_project_root_index_invalid");
    }
  }
}

function identifier(value: string | undefined, maximum: number): boolean {
  return (
    typeof value === "string" &&
    codePointLength(value) >= 1 &&
    codePointLength(value) <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  );
}

function shortText(value: string | undefined): boolean {
  return typeof value === "string" && codePointLength(value) > 0 && codePointLength(value) <= 256;
}

function boundedText(value: string | undefined): boolean {
  return typeof value === "string" && codePointLength(value) <= 16_384;
}

function timestamp(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function linearIssueState(value: string | undefined): boolean {
  return isTargetWorkflowStatusName(value);
}

function linearPriority(value: string | undefined): boolean {
  return (
    value === "urgent" ||
    value === "high" ||
    value === "normal" ||
    value === "low" ||
    value === "no_priority"
  );
}

function workflowStatusCategory(value: string | undefined): boolean {
  return value === "backlog" || value === "unstarted" || value === "started" ||
    value === "completed" || value === "canceled";
}

function workflowCommentAuthorKind(value: string | undefined): boolean {
  return value === "human" || value === "symphony" || value === "linear_integration" ||
    value === "external_automation" || value === "unknown";
}

function workflowCommentThreadState(value: string | undefined): boolean {
  return value === "resolved" || value === "unresolved";
}

function workflowRelationKind(value: string | undefined): boolean {
  return value === "blocks" || value === "blocked_by" || value === "relates_to" || value === "triggered_by";
}

function workflowActivityKind(value: string | undefined): boolean {
  return value === "status_changed" || value === "description_changed" ||
    value === "archive_changed" || value === "labels_changed" ||
    value === "parent_changed" || value === "delegation_changed" ||
    value === "attachment_changed";
}

function workflowActivityReferencesValid(
  activity: Awaited<ReturnType<LinearClientInterface["getWorkflowIssueTree"]>>["activities"][number],
): boolean {
  const optionalIds = [
    activity.fromStateId, activity.toStateId, activity.fromParentId, activity.toParentId,
    activity.fromDelegateId, activity.toDelegateId, activity.attachmentId,
  ];
  const idArrays = [activity.addedLabelIds, activity.removedLabelIds];
  return optionalIds.every((value) => value === undefined || identifier(value, 128)) &&
    (activity.updatedDescription === undefined || boundedText(activity.updatedDescription)) &&
    (activity.archived === undefined || typeof activity.archived === "boolean") &&
    idArrays.every((values) => values === undefined ||
      (Array.isArray(values) && values.length <= 64 && new Set(values).size === values.length &&
        values.every((value) => identifier(value, 128))));
}

function validateWorkflowSourceFacts(
  tree: Awaited<ReturnType<LinearClientInterface["getWorkflowIssueTree"]>>,
  projectId: string,
): void {
  if (
    !tree.coverage ||
    tree.coverage.isComplete !== true ||
    !Array.isArray(tree.coverage.omissions) ||
    tree.coverage.omissions.length !== 0 ||
    !Array.isArray(tree.sourceManifest) ||
    tree.sourceManifest.length > 16_384
  ) {
    throw new Error("linear_workflow_source_coverage_incomplete");
  }
  const expected = new Map<string, string>();
  for (const issue of tree.issues) {
    expected.set(`linear_issue:${issue.issueId}`, issue.remoteVersion);
  }
  for (const comment of tree.comments) {
    expected.set(`linear_comment:${comment.commentId}`, comment.remoteVersion);
  }
  for (const relation of tree.relations) {
    expected.set(`linear_relation:${relation.relationId}`, relation.relationId);
  }
  for (const attachment of tree.attachments) {
    expected.set(`linear_attachment:${attachment.attachmentId}`, attachment.remoteVersion);
  }
  for (const activity of tree.activities) {
    expected.set(`linear_activity:${activity.activityId}`, activity.remoteVersion);
  }
  const statusSourceId = `${projectId}:status-catalog`;
  expected.set("linear_status_catalog:" + statusSourceId, "");

  const seen = new Set<string>();
  for (const source of tree.sourceManifest) {
    if (
      !workflowSourceKind(source.sourceKind) ||
      !identifier(source.sourceId, 128) ||
      !identifier(source.sourceVersion, 512) ||
      !workflowCommentAuthorKind(source.actorKind) ||
      (source.stableWriteId !== undefined && !identifier(source.stableWriteId, 128))
    ) {
      throw new Error("linear_workflow_source_manifest_invalid");
    }
    const key = `${source.sourceKind}:${source.sourceId}`;
    const expectedVersion = expected.get(key);
    if (
      seen.has(key) ||
      expectedVersion === undefined ||
      (source.sourceKind !== "linear_status_catalog" && source.sourceVersion !== expectedVersion) ||
      (source.sourceKind === "linear_status_catalog" && source.sourceId !== statusSourceId)
    ) {
      throw new Error("linear_workflow_source_manifest_invalid");
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    throw new Error("linear_workflow_source_manifest_incomplete");
  }
}

function workflowSourceKind(value: string | undefined): boolean {
  return value === "linear_issue" || value === "linear_comment" ||
    value === "linear_relation" || value === "linear_attachment" ||
    value === "linear_activity" ||
    value === "linear_status_catalog";
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
