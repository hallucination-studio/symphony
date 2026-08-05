import type { LinearComment } from "../contracts/task-management.js";
import type { LinearGateway } from "./LinearGateway.js";
import { isHarnessComment } from "./LinearMarkers.js";

export async function readRootInbox(
  gateway: LinearGateway,
  rootId: string,
  cursor?: string,
): Promise<readonly LinearComment[]> {
  const comments = await gateway.list_root_comments_after(rootId, cursor);
  const ids = new Set<string>();
  const eligible = comments.flatMap((comment) => {
    if (comment.issue_id !== rootId) throw new Error("linear_root_comment_issue_mismatch");
    if (ids.has(comment.id)) throw new Error("linear_root_comment_duplicated");
    ids.add(comment.id);
    const createdAt = new Date(comment.created_at);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== comment.created_at) {
      throw new Error("linear_root_comment_timestamp_invalid");
    }
    return isHarnessComment(comment.body) ? [] : [comment];
  });
  return Object.freeze(eligible.sort(
    (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id),
  ));
}
