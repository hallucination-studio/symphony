import type { ProtocolError } from "../errors.js";
import type { LinearClientInterface } from "./api/LinearClientInterface.js";
import type {
  LinearMutationCommand,
  LinearMutationResult,
  RemotePrecondition,
  RootIssueValue,
  RootUsageValue,
  LinearIssueValue,
} from "./types.js";

interface RetryOptions {
  sleep(delayMs: number): Promise<void>;
  maxAttempts: number;
  baseDelayMs: number;
}

const MAX_ROOTS = 512;
const MAX_TREE_NODES = 512;

function errorRecord(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};
}

const retryableLinearErrors = new Set([
  "RatelimitedLinearError",
  "NetworkLinearError",
  "InternalLinearError",
]);
const ambiguousLinearErrors = new Set([
  "NetworkLinearError",
  "InternalLinearError",
]);

const officialLinearFailures = new Map([
  [
    "RatelimitedLinearError",
    {
      code: "linear_rate_limited",
      sanitizedReason: "Linear rate limit exceeded.",
    },
  ],
  [
    "NetworkLinearError",
    {
      code: "linear_network_failed",
      sanitizedReason: "Linear network request failed.",
    },
  ],
  [
    "InternalLinearError",
    {
      code: "linear_internal_failed",
      sanitizedReason: "Linear internal request failed.",
    },
  ],
]);

function errorClass(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "";
}

function normalizedFailure(error: unknown): {
  code: string;
  sanitizedReason: string;
} {
  const official = officialLinearFailures.get(errorClass(error));
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
  return {
    code: normalized.code,
    category: "linear",
    sanitizedReason: normalized.sanitizedReason,
    retryable: false,
    actionRequired: "block_root",
    nextAction: "Resolve the Linear error, then retry the Root.",
  };
}

function matchesPrecondition(
  target: Awaited<ReturnType<LinearClientInterface["readMutationTarget"]>>,
  precondition: RemotePrecondition,
): boolean {
  if (!target) return false;
  return (
    target.issueId === precondition.expectedIssueId &&
    target.updatedAt === precondition.expectedUpdatedAt &&
    (precondition.expectedState === undefined ||
      target.state === precondition.expectedState) &&
    (precondition.expectedParentIssueId === undefined ||
      target.parentIssueId === precondition.expectedParentIssueId) &&
    (precondition.expectedManagedMarker === undefined ||
      target.managedMarker === precondition.expectedManagedMarker)
  );
}

function commandPrecondition(
  command: LinearMutationCommand,
): RemotePrecondition | undefined {
  if ("precondition" in command) return command.precondition;
  if ("rootPrecondition" in command) return command.rootPrecondition;
  return undefined;
}

export class LinearGatewayProtocolHandlerImpl {
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

  async listAllRootIssues(projectId: string): Promise<RootIssueValue[]> {
    const list = this.client.listRootIssues;
    const items: RootIssueValue[] = [];
    let cursor: string | undefined;
    do {
      const page = await list.call(this.client, {
        projectId,
        ...(cursor ? { cursor } : {}),
        limit: 250,
      });
      for (const item of page.items) {
        validateIssue(item.issue, projectId);
        if (item.issue.parentIssueId !== undefined || item.issue.depth !== 0) {
          throw new Error("linear_root_shape_invalid");
        }
        items.push(item);
        if (items.length > MAX_ROOTS) {
          throw new Error("linear_root_collection_too_large");
        }
      }
      cursor = nextCursor(page.pageInfo);
    } while (cursor);
    return items;
  }

  async getCompleteIssueTree(
    projectId: string,
    rootIssueId: string,
  ): Promise<{ rootIssueId: string; nodes: LinearIssueValue[]; observedAt: string }> {
    const getTree = this.client.getIssueTree;
    const nodes: LinearIssueValue[] = [];
    let observedAt = "";
    let cursor: string | undefined;
    do {
      const page = await getTree.call(this.client, {
        projectId,
        rootIssueId,
        ...(cursor ? { cursor } : {}),
        limit: 250,
      });
      for (const node of page.nodes) {
        validateIssue(node, projectId);
        if (
          (node.issueId === rootIssueId &&
            (node.parentIssueId !== undefined || node.depth !== 0)) ||
          (node.issueId !== rootIssueId &&
            (node.parentIssueId === undefined || node.depth === 0))
        ) {
          throw new Error("linear_tree_shape_invalid");
        }
        nodes.push(node);
        if (nodes.length > MAX_TREE_NODES) {
          throw new Error("linear_tree_collection_too_large");
        }
      }
      observedAt = page.observedAt;
      cursor = nextCursor(page.pageInfo);
    } while (cursor);
    if (!nodes.some(({ issueId }) => issueId === rootIssueId)) {
      throw new Error("linear_tree_root_missing");
    }
    return { rootIssueId, nodes, observedAt };
  }

  async listAllRootUsage(projectId: string): Promise<RootUsageValue[]> {
    const list = this.client.listRootUsage;
    const items: RootUsageValue[] = [];
    let cursor: string | undefined;
    do {
      const page = await list.call(this.client, {
        projectId,
        ...(cursor ? { cursor } : {}),
        limit: 250,
      });
      for (const usage of page.items) {
        const counters = [
          usage.inputTokens,
          usage.cachedInputTokens,
          usage.outputTokens,
          usage.reasoningOutputTokens,
          usage.totalTokens,
        ];
        if (
          !identifier(usage.rootIssueId, 128) ||
          !timestamp(usage.observedAt) ||
          !counters.every(
            (value) => Number.isSafeInteger(value) && value >= 0,
          )
        ) {
          throw new Error("linear_usage_invalid");
        }
        items.push(usage);
        if (items.length > MAX_ROOTS) {
          throw new Error("linear_usage_collection_too_large");
        }
      }
      cursor = nextCursor(page.pageInfo);
    } while (cursor);
    return items;
  }

  async mutate(command: LinearMutationCommand): Promise<LinearMutationResult> {
    let readBackBeforeRetry = false;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      let mutationAttempted = false;
      try {
        if (readBackBeforeRetry) {
          const outcome = await this.client.readMutationOutcome(command);
          if (outcome) return { kind: "already_applied", ...outcome };
          readBackBeforeRetry = false;
        }
        const idempotentOutcome = await this.#checkIdempotentOutcome(command);
        if (idempotentOutcome) return idempotentOutcome;
        const preconditionFailure = await this.#checkPreconditions(command);
        if (preconditionFailure) return preconditionFailure;
        mutationAttempted = true;
        await this.client.executeMutation(command);
        const readBack = await this.client.readMutationOutcome(command);
        if (!readBack) {
          const error = new Error("linear_mutation_read_back_mismatch") as Error & {
            retryable: boolean;
            ambiguous: boolean;
          };
          error.retryable = true;
          error.ambiguous = true;
          throw error;
        }
        return { kind: "applied", ...readBack };
      } catch (error) {
        const record = errorRecord(error);
        if (record.preconditionConflict === true) {
          return { kind: "linear_precondition_conflict" };
        }
        const classification = errorClass(error);
        const isRetryable =
          record.retryable === true ||
          retryableLinearErrors.has(classification);
        const isAmbiguous =
          record.ambiguous === true ||
          ambiguousLinearErrors.has(classification);
        if (isAmbiguous && mutationAttempted) {
          readBackBeforeRetry = true;
          try {
            const outcome = await this.client.readMutationOutcome(command);
            if (outcome) return { kind: "already_applied", ...outcome };
          } catch (readBackError) {
            if (attempt === this.retry.maxAttempts) {
              return {
                kind: "failed",
                error: protocolFailure(readBackError),
              };
            }
          }
        }
        if (!isRetryable || attempt === this.retry.maxAttempts) {
          return { kind: "failed", error: protocolFailure(error) };
        }
        await this.retry.sleep(
          this.retry.baseDelayMs * 2 ** (attempt - 1),
        );
      }
    }

    return {
      kind: "failed",
      error: protocolFailure(new Error("Linear retry exhausted.")),
    };
  }

  async #checkIdempotentOutcome(
    command: LinearMutationCommand,
  ): Promise<LinearMutationResult | undefined> {
    if (
      command.kind !== "create_managed_node" &&
      command.kind !== "upsert_root_managed_comment"
    ) {
      return undefined;
    }
    const projectFailure = await this.#checkProjectPrecondition(command);
    if (projectFailure) return projectFailure;
    if (command.kind === "create_managed_node") {
      const target = await this.client.readManagedMarkerTarget(
        command.managedMarker,
      );
      if (!target) return undefined;
      const outcome = await this.client.readMutationOutcome(command);
      return outcome
        ? { kind: "already_applied", ...outcome }
        : { kind: "linear_precondition_conflict" };
    }
    const outcome = await this.client.readMutationOutcome(command);
    return outcome ? { kind: "already_applied", ...outcome } : undefined;
  }

  async #checkPreconditions(
    command: LinearMutationCommand,
  ): Promise<
    | { kind: "conductor_project_resolution_changed" }
    | { kind: "linear_precondition_conflict" }
    | undefined
  > {
    const projectFailure = await this.#checkProjectPrecondition(command);
    if (projectFailure) return projectFailure;

    const precondition = commandPrecondition(command);
    if (precondition) {
      const target = await this.client.readMutationTarget(
        precondition.expectedIssueId,
      );
      if (!matchesPrecondition(target, precondition)) {
        return { kind: "linear_precondition_conflict" };
      }
    }
    if (
      command.kind === "upsert_root_managed_comment" &&
      command.commentPrecondition
    ) {
      const comment = await this.client.readCommentTarget(
        command.commentPrecondition.expectedIssueId,
      );
      if (
        !comment ||
        comment.issueId !== command.rootPrecondition.expectedIssueId ||
        comment.updatedAt !== command.commentPrecondition.expectedUpdatedAt ||
        (command.commentPrecondition.expectedManagedMarker !== undefined &&
          comment.managedMarker !==
            command.commentPrecondition.expectedManagedMarker)
      ) {
        return { kind: "linear_precondition_conflict" };
      }
    }
    if (
      command.kind === "upsert_root_managed_comment" &&
      !command.commentPrecondition
    ) {
      const comment = await this.client.readRootManagedComment(
        command.rootPrecondition.expectedIssueId,
      );
      if (comment) return { kind: "linear_precondition_conflict" };
    }
    return undefined;
  }

  async #checkProjectPrecondition(
    command: LinearMutationCommand,
  ): Promise<
    | { kind: "conductor_project_resolution_changed" }
    | { kind: "linear_precondition_conflict" }
    | undefined
  > {
    const resolution = await this.client.readProjectResolution({
      conductorShortHash: command.project.conductorShortHash,
    });
    if (
      resolution.kind !== "resolved" ||
      resolution.projectId !== command.project.expectedProjectId
    ) {
      return { kind: "conductor_project_resolution_changed" };
    }
    if (resolution.updatedAt !== command.project.expectedProjectUpdatedAt) {
      return { kind: "linear_precondition_conflict" };
    }
    return undefined;
  }
}

function nextCursor(pageInfo: { hasNextPage: boolean; endCursor?: string }): string | undefined {
  if (!pageInfo.hasNextPage) return undefined;
  if (!pageInfo.endCursor) throw new Error("linear_pagination_cursor_missing");
  return pageInfo.endCursor;
}

function validateIssue(issue: LinearIssueValue, projectId: string): void {
  if (issue.projectId !== projectId) throw new Error("linear_project_mismatch");
  if (
    !identifier(issue.issueId, 128) ||
    !identifier(issue.identifier, 256) ||
    !linearIssueState(issue.state) ||
    (issue.parentIssueId !== undefined &&
      !identifier(issue.parentIssueId, 128)) ||
    !Number.isFinite(issue.order) ||
    issue.order! < -1_000_000_000 ||
    issue.order! > 1_000_000_000 ||
    issue.depth === undefined ||
    !Number.isInteger(issue.depth) ||
    issue.depth < 0 ||
    issue.depth > 32 ||
    typeof issue.title !== "string" ||
    codePointLength(issue.title) > 16_384 ||
    typeof issue.description !== "string" ||
    codePointLength(issue.description) > 16_384 ||
    !timestamp(issue.updatedAt)
  ) throw new Error("linear_issue_invalid");
  if (!managedNodeShapeValid(issue)) {
    throw new Error("linear_managed_node_shape_invalid");
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

function timestamp(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(Date.parse(value))
  );
}

function linearIssueState(value: string | undefined): boolean {
  return (
    value === "Todo" ||
    value === "In Progress" ||
    value === "In Review" ||
    value === "Done" ||
    value === "Canceled"
  );
}

function managedNodeShapeValid(issue: LinearIssueValue): boolean {
  if (issue.nodeKind === undefined) {
    return (
      issue.humanKind === undefined &&
      issue.origin === undefined &&
      issue.completedInputHash === undefined &&
      issue.targetIssueId === undefined
    );
  }
  if (issue.nodeKind === "work") {
    return (
      issue.humanKind === undefined &&
      issue.targetIssueId === undefined &&
      (issue.origin === "user" || issue.origin === "symphony") &&
      (issue.completedInputHash === undefined ||
        identifier(issue.completedInputHash, 128)) &&
      (issue.origin === "user" || issue.managedMarker !== undefined)
    );
  }
  if (
    issue.nodeKind !== "human" ||
    issue.managedMarker === undefined ||
    issue.origin !== undefined ||
    issue.completedInputHash !== undefined ||
    issue.humanKind === undefined
  ) {
    return false;
  }
  return issue.humanKind === "plan_approval"
    ? issue.targetIssueId === undefined
    : identifier(issue.targetIssueId, 128);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
