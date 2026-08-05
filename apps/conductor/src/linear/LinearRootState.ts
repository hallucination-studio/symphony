import { parseRootState, type RootState } from "../contracts/root.js";
import { parseLinearComment, type LinearComment } from "../contracts/task-management.js";
import { parseMarkdownText, type MarkdownText } from "../contracts/validation.js";
import type { LinearGateway } from "./LinearGateway.js";
import { isRootStateComment, ROOT_STATE_COMMENT_MARKER } from "./LinearMarkers.js";

const JSON_BLOCK_PREFIX = `${ROOT_STATE_COMMENT_MARKER}\n\n\`\`\`json\n`;
const JSON_BLOCK_SUFFIX = "\n```";

export interface RootStateCommentProjection {
  readonly comment: LinearComment;
  readonly state: RootState;
}

export function renderRootStateComment(value: RootState): MarkdownText {
  const state = parseRootState(value);
  return parseMarkdownText(
    `${JSON_BLOCK_PREFIX}${JSON.stringify(state, null, 2)}${JSON_BLOCK_SUFFIX}`,
    "linear_root_state_comment_malformed",
  );
}

export function parseRootStateComment(comment: LinearComment): RootState {
  try {
    if (!isRootStateComment(comment.body)) throw new Error("invalid");
    if (!comment.body.startsWith(JSON_BLOCK_PREFIX) || !comment.body.endsWith(JSON_BLOCK_SUFFIX)) {
      throw new Error("invalid");
    }
    const json = comment.body.slice(JSON_BLOCK_PREFIX.length, -JSON_BLOCK_SUFFIX.length);
    const state = parseRootState(JSON.parse(json) as unknown);
    if (renderRootStateComment(state) !== comment.body) throw new Error("invalid");
    return state;
  } catch {
    throw new Error("linear_root_state_comment_malformed");
  }
}

export function findRootStateComment(
  comments: readonly LinearComment[],
): RootStateCommentProjection | null {
  const matches = comments.filter((comment) => isRootStateComment(comment.body));
  if (matches.length > 1) throw new Error("linear_root_state_comment_duplicated");
  const comment = matches[0];
  return comment === undefined
    ? null
    : Object.freeze({ comment, state: parseRootStateComment(comment) });
}

export async function createRootStateComment(
  gateway: LinearGateway,
  rootId: string,
  state: RootState,
): Promise<RootStateCommentProjection> {
  const existing = await gateway.find_root_state_comment(rootId);
  if (existing !== null) {
    parseRootStateComment(existing);
    throw new Error("linear_root_state_comment_duplicated");
  }
  const comment = await gateway.create_comment(rootId, renderRootStateComment(state));
  return Object.freeze({ comment, state: parseRootStateComment(comment) });
}

export async function updateRootStateComment(
  gateway: LinearGateway,
  existing: LinearComment,
  state: RootState,
): Promise<RootStateCommentProjection> {
  parseRootStateComment(existing);
  const current = await gateway.find_root_state_comment(existing.issue_id);
  if (current === null) throw new Error("linear_root_state_comment_missing");
  if (current.id !== existing.id) throw new Error("linear_root_state_comment_mismatch");
  parseRootStateComment(current);
  const body = renderRootStateComment(state);
  await gateway.update_comment(existing.id, body);
  const comment = parseLinearComment({ ...existing, body });
  return Object.freeze({ comment, state: parseRootStateComment(comment) });
}
