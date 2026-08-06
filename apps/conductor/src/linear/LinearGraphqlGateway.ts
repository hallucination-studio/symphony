import type {
  LinearUploadedFile,
  LinearUploadContentType,
  LinearComment,
  LinearCreateIssueRequest,
  LinearCreateWorkflowStateRequest,
  LinearGateway,
  LinearIssue,
  LinearReaction,
  LinearReactionEmoji,
  LinearUnfinishedDescendant,
  LinearWorkflowState,
} from "./LinearGateway.js";
import {
  LINEAR_REACTION_EMOJIS,
  parseLinearComment,
  parseLinearIssue,
  parseLinearReaction,
} from "../contracts/task-management.js";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_UPLOAD_RESPONSE_BYTES = 64 * 1024;
const UPLOAD_CACHE_CONTROL = "public, max-age=31536000";
const STATE_TYPES = new Set<LinearWorkflowState["type"]>([
  "backlog", "unstarted", "started", "completed", "canceled",
]);

type UnknownRecord = Record<string, unknown>;

type LinearGraphqlTransport = (
  operation: string,
  document: string,
  variables: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
) => Promise<unknown>;

function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
  return value as UnknownRecord;
}

function boundedString(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new Error("invalid");
  }
  return value;
}

function identifier(value: unknown): string {
  const parsed = boundedString(value, 256);
  if (/[\r\n]/u.test(parsed)) throw new Error("invalid");
  return parsed;
}

function nullableIdentifier(value: unknown): string | null {
  return value === null ? null : identifier(value);
}

function nestedId(value: unknown): string {
  return identifier(record(value).id);
}

function nullableNestedId(value: unknown): string | null {
  return value === null ? null : nestedId(value);
}

function timestamp(value: unknown): string {
  const parsed = identifier(value);
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== parsed) throw new Error("invalid");
  return parsed;
}

function linearUrl(value: unknown): string {
  const parsed = identifier(value);
  const url = new URL(parsed);
  if (url.protocol !== "https:") throw new Error("invalid");
  return parsed;
}

function attachmentUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || /[\r\n\0]/u.test(value)) {
    throw new Error("invalid");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("invalid");
  }
  return value;
}

interface LinearUploadFile {
  readonly upload_url: string;
  readonly asset_url: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}

function uploadFile(value: unknown): LinearUploadFile {
  const raw = record(value);
  if (raw.success !== true) throw new Error("invalid");
  const upload = record(raw.uploadFile);
  if (!Array.isArray(upload.headers)) throw new Error("invalid");
  const seenHeaders = new Set<string>();
  const forbiddenHeaders = new Set([
    "authorization", "proxy-authorization", "cookie", "set-cookie", "host",
    "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer",
  ]);
  const headers = upload.headers.map((value) => {
    const header = record(value);
    const key = boundedString(header.key, 256);
    const headerValue = boundedString(header.value, 8_192);
    const normalizedKey = key.toLowerCase();
    if (seenHeaders.has(normalizedKey) || forbiddenHeaders.has(normalizedKey)) throw new Error("invalid");
    seenHeaders.add(normalizedKey);
    const probe = new Headers();
    try {
      probe.set(key, headerValue);
    } catch {
      throw new Error("invalid");
    }
    return Object.freeze({ key, value: headerValue });
  });
  return Object.freeze({
    upload_url: attachmentUrl(upload.uploadUrl),
    asset_url: attachmentUrl(upload.assetUrl),
    headers: Object.freeze(headers),
  });
}

function issue(value: unknown): LinearIssue {
  const raw = record(value);
  const state = record(raw.state);
  return parseLinearIssue({
    id: identifier(raw.id),
    identifier: identifier(raw.identifier),
    title: boundedString(raw.title, 1_024),
    description: boundedString(raw.description, 100_000),
    url: linearUrl(raw.url),
    status: normalizedStatus(identifier(state.type)),
    status_id: identifier(state.id),
    parent_id: nullableNestedId(raw.parent),
    team_id: nestedId(raw.team),
    creator_id: nullableNestedId(raw.creator),
  });
}

function workflowState(value: unknown): LinearWorkflowState {
  const raw = record(value);
  return Object.freeze({
    id: identifier(raw.id),
    name: boundedString(raw.name, 256),
    type: identifier(raw.type),
    team_id: nestedId(raw.team),
  });
}

function normalizedStatus(type: string): LinearIssue["status"] {
  switch (type) {
    case "backlog":
    case "unstarted":
      return "todo";
    case "started":
      return "active";
    case "completed":
      return "completed";
    case "canceled":
      return "canceled";
    default:
      throw new Error("invalid");
  }
}

function comment(
  value: unknown,
  expectedIssueId?: string,
  expectedParentId?: string | null,
): LinearComment {
  const raw = record(value);
  const issueId = raw.issue === undefined
    ? expectedIssueId
    : nestedId(raw.issue);
  if (issueId === undefined) throw new Error("invalid");
  if (expectedIssueId !== undefined && issueId !== expectedIssueId) throw new Error("invalid");
  if (!Object.hasOwn(raw, "parentId")) throw new Error("invalid");
  const parentId = nullableIdentifier(raw.parentId);
  if (expectedParentId !== undefined && parentId !== expectedParentId) throw new Error("invalid");
  return parseLinearComment({
    id: identifier(raw.id),
    issue_id: issueId,
    parent_id: parentId,
    body: boundedString(raw.body, 100_000),
    creator_id: nestedId(raw.user),
    created_at: timestamp(raw.createdAt),
  });
}

function reaction(
  value: unknown,
  replyId: string,
  requestedEmoji: LinearReactionEmoji,
): LinearReaction {
  const raw = record(value);
  const parsed = parseLinearReaction({
    id: identifier(raw.id),
    reply_id: replyId,
    emoji: raw.emoji,
  });
  if (parsed.emoji !== requestedEmoji) throw new Error("invalid");
  return parsed;
}

function connection(value: unknown): {
  readonly nodes: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
} {
  const raw = record(value);
  if (!Array.isArray(raw.nodes)) throw new Error("invalid");
  const pageInfo = record(raw.pageInfo);
  if (typeof pageInfo.hasNextPage !== "boolean") throw new Error("invalid");
  const endCursor = pageInfo.endCursor === null ? null : identifier(pageInfo.endCursor);
  if (pageInfo.hasNextPage && endCursor === null) throw new Error("invalid");
  return Object.freeze({
    nodes: Object.freeze([...raw.nodes]),
    hasNextPage: pageInfo.hasNextPage,
    endCursor,
  });
}

function safeResource(value: string): string {
  return /^[A-Za-z0-9:_-]{1,128}$/u.test(value) ? value : "invalid-resource";
}

function validateLocal(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new Error("linear_invalid_request");
  }
}

function providerError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(boundedString(record(value).message, 100_000));
}

function operationDocument(operation: string): string {
  const documents: Readonly<Record<string, string>> = {
    GetIssue: `query GetIssue($issueRef: String!) {
      issue(id: $issueRef) { id identifier title description url state { id type } parent { id } team { id } creator { id } }
    }`,
    ListTeamStates: `query ListTeamStates($teamId: ID!, $cursor: String, $first: Int!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }, after: $cursor, first: $first) {
        nodes { id name type team { id } } pageInfo { hasNextPage endCursor }
      }
    }`,
    CreateWorkflowState: `mutation CreateWorkflowState($input: WorkflowStateCreateInput!) {
      workflowStateCreate(input: $input) { success workflowState { id name type team { id } } }
    }`,
    ListIssueComments: `query ListIssueComments($issueRef: String!, $cursor: String, $first: Int!) {
      issue(id: $issueRef) { comments(after: $cursor, first: $first) {
        nodes { id body createdAt issue { id } parentId user { id } } pageInfo { hasNextPage endCursor }
      } }
    }`,
    ListCommentReplies: `query ListCommentReplies($commentId: String!, $cursor: String, $first: Int!) {
      comment(id: $commentId) { issue { id } children(after: $cursor, first: $first) {
        nodes { id body createdAt issue { id } parentId user { id } } pageInfo { hasNextPage endCursor }
      } }
    }`,
    ListIssueChildren: `query ListIssueChildren($issueRef: String!, $cursor: String, $first: Int!) {
      issue(id: $issueRef) { children(after: $cursor, first: $first) {
        nodes { id state { id type } } pageInfo { hasNextPage endCursor }
      } }
    }`,
    CreateIssue: `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue {
        id identifier title description url state { id type } parent { id } team { id } creator { id }
      } }
    }`,
    UpdateIssueStatus: `mutation UpdateIssueStatus($issueId: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $issueId, input: $input) { success }
    }`,
    UpdateIssueDescription: `mutation UpdateIssueDescription($issueId: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $issueId, input: $input) { success }
    }`,
    CreateComment: `mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id body createdAt issue { id } parentId user { id } } }
    }`,
    CreateCommentReply: `mutation CreateCommentReply($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id body createdAt issue { id } parentId user { id } } }
    }`,
    ReactionCreate: `mutation ReactionCreate($input: ReactionCreateInput!) {
      reactionCreate(input: $input) { success reaction { id emoji } }
    }`,
    FileUpload: `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`,
  };
  const document = documents[operation];
  if (document === undefined) throw new Error("linear_graphql_operation_invalid");
  return document;
}

export class LinearGraphqlGateway implements LinearGateway {
  constructor(
    private readonly transport: LinearGraphqlTransport,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("linear_timeout_invalid");
    }
  }

  async get_issue(issueRef: string): Promise<LinearIssue> {
    const data = await this.#request("GetIssue", "get_issue", issueRef, { issueRef });
    return this.#parse("get_issue", issueRef, () => issue(data.issue), data.issue);
  }

  async list_team_states(teamId: string): Promise<readonly LinearWorkflowState[]> {
    const states: LinearWorkflowState[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.#request("ListTeamStates", "list_team_states", teamId, {
        teamId, cursor, first: PAGE_SIZE,
      });
      const parsed = this.#parse(
        "list_team_states", teamId, () => connection(data.workflowStates), data.workflowStates,
      );
      states.push(...this.#parse(
        "list_team_states", teamId, () => parsed.nodes.map(workflowState), parsed.nodes,
      ));
      if (!parsed.hasNextPage) return Object.freeze(states);
      cursor = this.#nextCursor("list_team_states", teamId, cursor, parsed.endCursor);
    }
    throw this.#invalid("list_team_states", teamId);
  }

  async create_workflow_state(
    request: LinearCreateWorkflowStateRequest,
  ): Promise<LinearWorkflowState> {
    validateLocal(request.team_id, 256);
    validateLocal(request.name, 256);
    if (!STATE_TYPES.has(request.type) || !/^#[0-9a-fA-F]{6}$/u.test(request.color)) {
      throw new Error("linear_create_workflow_state_invalid_request");
    }
    const data = await this.#request(
      "CreateWorkflowState", "create_workflow_state", request.team_id, {
        input: {
          teamId: request.team_id,
          name: request.name,
          type: request.type,
          color: request.color,
        },
      },
    );
    const payload = this.#parse(
      "create_workflow_state", request.team_id,
      () => record(data.workflowStateCreate), data.workflowStateCreate,
    );
    if (payload.success !== true) {
      throw new Error(`linear_create_workflow_state_failed:${safeResource(request.team_id)}`);
    }
    return this.#parse(
      "create_workflow_state", request.team_id,
      () => workflowState(payload.workflowState), payload.workflowState,
    );
  }

  async list_root_comments_after(rootId: string, cursor?: string): Promise<readonly LinearComment[]> {
    const comments = await this.#listComments(rootId);
    if (cursor === undefined) return comments;
    const cursorIndex = comments.findIndex((entry) => entry.id === cursor);
    if (cursorIndex < 0) throw new Error("linear_comment_cursor_not_found");
    return Object.freeze(comments.slice(cursorIndex + 1));
  }

  async list_comment_replies_after(commentId: string, cursor?: string): Promise<readonly LinearComment[]> {
    validateLocal(commentId, 256);
    const comments = await this.#listCommentReplies(commentId);
    if (cursor === undefined) return comments;
    const cursorIndex = comments.findIndex((entry) => entry.id === cursor);
    if (cursorIndex < 0) throw new Error("linear_comment_cursor_not_found");
    return Object.freeze(comments.slice(cursorIndex + 1));
  }

  async list_unfinished_descendants(rootId: string): Promise<readonly LinearUnfinishedDescendant[]> {
    const unfinished: LinearUnfinishedDescendant[] = [];
    const pending = [rootId];
    while (pending.length > 0) {
      const parentId = pending.shift() as string;
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const data = await this.#request("ListIssueChildren", "list_unfinished_descendants", rootId, {
          issueRef: parentId, cursor, first: PAGE_SIZE,
        });
        const childConnection = this.#parse(
          "list_unfinished_descendants",
          rootId,
          () => connection(record(data.issue).children),
          data.issue,
        );
        for (const value of childConnection.nodes) {
          const child = this.#parse("list_unfinished_descendants", rootId, () => record(value), value);
          const id = this.#parse("list_unfinished_descendants", rootId, () => identifier(child.id), child.id);
          const state = this.#parse(
            "list_unfinished_descendants", rootId, () => record(child.state), child.state,
          );
          this.#parse("list_unfinished_descendants", rootId, () => identifier(state.id), state.id);
          const type = this.#parse(
            "list_unfinished_descendants", rootId, () => identifier(state.type), state.type,
          );
          if (!STATE_TYPES.has(type as LinearWorkflowState["type"])) {
            throw this.#invalid("list_unfinished_descendants", rootId);
          }
          pending.push(id);
          const status = normalizedStatus(type);
          if (status !== "completed" && status !== "canceled") unfinished.push(Object.freeze({ id, status }));
        }
        if (!childConnection.hasNextPage) break;
        cursor = this.#nextCursor("list_unfinished_descendants", rootId, cursor, childConnection.endCursor);
        if (page === MAX_PAGES - 1) throw this.#invalid("list_unfinished_descendants", rootId);
      }
    }
    return Object.freeze(unfinished);
  }

  async create_issue(request: LinearCreateIssueRequest): Promise<LinearIssue> {
    validateLocal(request.team_id, 256);
    if (request.parent_id !== null) validateLocal(request.parent_id, 256);
    validateLocal(request.title, 1_024);
    validateLocal(request.description, 100_000);
    validateLocal(request.status_id, 256);
    const data = await this.#request("CreateIssue", "create_issue", request.parent_id ?? request.team_id, {
      input: {
        teamId: request.team_id,
        parentId: request.parent_id,
        title: request.title,
        description: request.description,
        stateId: request.status_id,
      },
    });
    return this.#parseMutationIssue("create_issue", request.parent_id ?? request.team_id, data.issueCreate);
  }

  async update_issue_status(issueId: string, statusId: string): Promise<void> {
    validateLocal(statusId, 256);
    const data = await this.#request("UpdateIssueStatus", "update_issue_status", issueId, {
      issueId, input: { stateId: statusId },
    });
    this.#parseSuccess("update_issue_status", issueId, data.issueUpdate);
  }

  async update_issue_description(issueId: string, description: string): Promise<void> {
    validateLocal(description, 100_000);
    const data = await this.#request("UpdateIssueDescription", "update_issue_description", issueId, {
      issueId, input: { description },
    });
    this.#parseSuccess("update_issue_description", issueId, data.issueUpdate);
  }

  async create_comment(issueId: string, body: string): Promise<LinearComment> {
    validateLocal(issueId, 256);
    validateLocal(body, 100_000);
    const data = await this.#request("CreateComment", "create_comment", issueId, {
      input: { issueId, body },
    });
    const payload = this.#parse(
      "create_comment", issueId, () => record(data.commentCreate), data.commentCreate,
    );
    if (payload.success !== true) throw new Error(`linear_create_comment_failed:${safeResource(issueId)}`);
    return this.#parse(
      "create_comment", issueId, () => comment(payload.comment, issueId, null), payload.comment,
    );
  }

  async create_comment_reply(issueId: string, commentId: string, body: string): Promise<LinearComment> {
    validateLocal(issueId, 256);
    validateLocal(commentId, 256);
    validateLocal(body, 100_000);
    const data = await this.#request("CreateCommentReply", "create_comment_reply", commentId, {
      input: { issueId, parentId: commentId, body },
    });
    const payload = this.#parse(
      "create_comment_reply", commentId,
      () => record(data.commentCreate), data.commentCreate,
    );
    if (payload.success !== true) throw new Error(`linear_create_comment_reply_failed:${safeResource(commentId)}`);
    return this.#parse(
      "create_comment_reply", commentId,
      () => comment(payload.comment, issueId, commentId), payload.comment,
    );
  }

  async create_comment_reaction(
    replyId: string,
    emoji: LinearReactionEmoji,
  ): Promise<LinearReaction> {
    validateLocal(replyId, 256);
    if (!(LINEAR_REACTION_EMOJIS as readonly string[]).includes(emoji)) {
      throw new Error("linear_comment_reaction_emoji_invalid");
    }
    const data = await this.#request("ReactionCreate", "create_comment_reaction", replyId, {
      input: { commentId: replyId, emoji },
    });
    const payload = this.#parse(
      "create_comment_reaction", replyId,
      () => record(data.reactionCreate), data.reactionCreate,
    );
    if (payload.success !== true) {
      throw new Error(`linear_create_comment_reaction_failed:${safeResource(replyId)}`);
    }
    return this.#parse(
      "create_comment_reaction", replyId,
      () => reaction(payload.reaction, replyId, emoji), payload.reaction,
    );
  }

  async upload_file(
    filename: string,
    contentType: LinearUploadContentType,
    contents: Uint8Array,
  ): Promise<LinearUploadedFile> {
    validateLocal(filename, 1_024);
    if (contentType !== "application/json") throw new Error("linear_upload_content_type_invalid");
    if (!(contents instanceof Uint8Array) || contents.byteLength > 2_147_483_647) {
      throw new Error("linear_upload_contents_invalid");
    }
    const body = contents.slice();
    const uploadData = await this.#requestUpload({
      contentType,
      filename,
      size: body.byteLength,
    });
    const uploaded = uploadFile(uploadData.fileUpload);
    const headers = new Headers();
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", UPLOAD_CACHE_CONTROL);
    for (const header of uploaded.headers) headers.set(header.key, header.value);
    await this.#putUpload(uploaded.upload_url, headers, body);

    return Object.freeze({ url: uploaded.asset_url });
  }

  async #listComments(issueId: string): Promise<readonly LinearComment[]> {
    const comments: LinearComment[] = [];
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.#request("ListIssueComments", "list_root_comments_after", issueId, {
        issueRef: issueId, cursor, first: PAGE_SIZE,
      });
      const parsed = this.#parse(
        "list_root_comments_after",
        issueId,
        () => connection(record(data.issue).comments),
        data.issue,
      );
      const pageComments = this.#parse(
        "list_root_comments_after",
        issueId,
        () => parsed.nodes.map((entry) => comment(entry, issueId)),
        parsed.nodes,
      );
      for (const entry of pageComments) {
        if (seenIds.has(entry.id)) throw this.#invalid("list_root_comments_after", issueId);
        seenIds.add(entry.id);
        if (entry.parent_id === null) comments.push(entry);
      }
      if (!parsed.hasNextPage) {
        return Object.freeze(comments.sort(
          (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
        ));
      }
      cursor = this.#nextCursor("list_root_comments_after", issueId, cursor, parsed.endCursor);
    }
    throw this.#invalid("list_root_comments_after", issueId);
  }

  async #listCommentReplies(commentId: string): Promise<readonly LinearComment[]> {
    const comments: LinearComment[] = [];
    const seenIds = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data = await this.#request("ListCommentReplies", "list_comment_replies_after", commentId, {
        commentId, cursor, first: PAGE_SIZE,
      });
      const parent = this.#parse(
        "list_comment_replies_after",
        commentId,
        () => record(data.comment),
        data.comment,
      );
      const expectedIssueId = this.#parse(
        "list_comment_replies_after",
        commentId,
        () => nestedId(parent.issue),
        parent.issue,
      );
      const parsed = this.#parse(
        "list_comment_replies_after",
        commentId,
        () => connection(parent.children),
        parent.children,
      );
      const pageComments = this.#parse(
        "list_comment_replies_after",
        commentId,
        () => parsed.nodes.map((entry) => comment(entry, expectedIssueId, commentId)),
        parsed.nodes,
      );
      for (const entry of pageComments) {
        if (seenIds.has(entry.id)) throw this.#invalid("list_comment_replies_after", commentId);
        seenIds.add(entry.id);
        comments.push(entry);
      }
      if (!parsed.hasNextPage) {
        return Object.freeze(comments.sort(
          (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
        ));
      }
      cursor = this.#nextCursor("list_comment_replies_after", commentId, cursor, parsed.endCursor);
    }
    throw this.#invalid("list_comment_replies_after", commentId);
  }

  #parseMutationIssue(operation: string, resource: string, value: unknown): LinearIssue {
    const payload = this.#parse(operation, resource, () => record(value), value);
    if (payload.success !== true) throw new Error(`linear_${operation}_failed:${safeResource(resource)}`);
    return this.#parse(operation, resource, () => issue(payload.issue), payload.issue);
  }

  #parseSuccess(operation: string, resource: string, value: unknown): void {
    const payload = this.#parse(operation, resource, () => record(value), value);
    if (payload.success !== true) throw new Error(`linear_${operation}_failed:${safeResource(resource)}`);
  }

  async #requestUpload(
    variables: Readonly<Record<string, unknown>>,
  ): Promise<UnknownRecord> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timeout"));
        }, this.timeoutMs);
      });
      const raw = await Promise.race([
        this.transport("FileUpload", operationDocument("FileUpload"), variables, controller.signal),
        timeout,
      ]);
      const envelope = record(raw);
      if (envelope.errors !== undefined && !Array.isArray(envelope.errors)) {
        throw new Error("invalid file upload response");
      }
      if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
        const error = envelope.errors[0];
        if (error instanceof Error) throw error;
        throw new Error("invalid file upload response");
      }
      return record(envelope.data);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #putUpload(
    uploadUrl: string,
    headers: Headers,
    contents: Uint8Array,
  ): Promise<void> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timeout"));
        }, this.timeoutMs);
      });
      const upload = (async () => {
        const response = await fetch(uploadUrl, {
          method: "PUT",
          headers,
          body: contents,
          signal: controller.signal,
        });
        await drainUploadResponse(response);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      })();
      await Promise.race([upload, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #nextCursor(operation: string, resource: string, current: string | null, next: string | null): string {
    if (next === null || next === current) throw this.#invalid(operation, resource);
    return next;
  }

  async #request(
    graphOperation: string,
    operation: string,
    resource: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<UnknownRecord> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let raw: unknown;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("timeout"));
        }, this.timeoutMs);
      });
      raw = await Promise.race([
        this.transport(graphOperation, operationDocument(graphOperation), variables, controller.signal),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    let envelope: UnknownRecord;
    try {
      envelope = record(raw);
      if (envelope.errors !== undefined && !Array.isArray(envelope.errors)) throw new Error("invalid");
    } catch {
      throw this.#invalid(operation, resource, raw);
    }
    const errors = envelope.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw this.#parse(operation, resource, () => providerError(errors[0]), errors[0]);
    }
    return this.#parse(operation, resource, () => record(envelope.data), envelope.data);
  }

  #parse<T>(operation: string, resource: string, parser: () => T, source?: unknown): T {
    try {
      return parser();
    } catch (error) {
      throw this.#invalid(operation, resource, { error, source });
    }
  }

  #invalid(operation: string, resource: string, cause?: unknown): Error {
    return new Error(`linear_${operation}_invalid_response:${safeResource(resource)}`, { cause });
  }
}

async function drainUploadResponse(response: Response): Promise<void> {
  if (response.body === null || response.body === undefined) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_UPLOAD_RESPONSE_BYTES) {
      throw new Error("upload response too large");
    }
    return;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > MAX_UPLOAD_RESPONSE_BYTES) throw new Error("upload response too large");
      chunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}

function productionTransport(accessToken: string): LinearGraphqlTransport {
  return async (_operation, document, variables, signal) => {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: document, variables }),
      signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error("linear_graphql_http_failed", {
        cause: { status: response.status, status_text: response.statusText, body },
      });
    }
    try {
      return JSON.parse(body) as unknown;
    } catch (error) {
      throw new Error("linear_graphql_response_invalid", { cause: { error, body } });
    }
  };
}

export function createProductionLinearGateway(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LinearGateway {
  const accessToken = env.LINEAR_API_KEY;
  if (accessToken === undefined || accessToken.trim().length === 0 || /[\r\n\0]/u.test(accessToken)) {
    throw new Error("linear_api_key_missing");
  }
  return new LinearGraphqlGateway(productionTransport(accessToken));
}
