import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { HumanActionKind } from "./HumanActionMaterializerInterface.js";
import { humanActionScopeFromBody } from "./HumanActionScope.js";

export { humanActionScopeFromBody } from "./HumanActionScope.js";

type WorkflowComment = LinearWorkflowTreeSnapshot["comments"][number];

export const humanActionHeadings: Record<HumanActionKind, string> = {
  plan_approval: "需要你审批",
  information: "需要你补充信息",
  permission: "需要你授权",
  finding_waiver: "需要你确认 Finding 豁免",
  root_decision: "需要你做出 Root 决策",
};

export function humanActionRequest(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  comment: WorkflowComment,
): { request: WorkflowComment; actionKind: HumanActionKind } | undefined {
  const request = tree.comments.find(({ comment_id }) => comment_id === comment.thread_root_comment_id);
  if (
    !request ||
    request.issue_id !== rootIssueId ||
    request.parent_comment_id !== undefined ||
    request.thread_root_comment_id !== request.comment_id ||
    request.author_kind !== "symphony"
  ) return undefined;

  const heading = request.body.split("\n", 1)[0];
  const actionKind = (Object.entries(humanActionHeadings) as Array<[HumanActionKind, string]>)
    .find(([, value]) => heading === `## ${value}`)?.[0];
  return actionKind ? { request, actionKind } : undefined;
}

export function humanActionRequestScope(
  request: WorkflowComment,
): { targetIdentifiers: string[]; contextIdentifiers: string[] } | undefined {
  return humanActionScopeFromBody(request.body);
}

export function humanActionSummaryStatus(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
): "Needs Approval" | "Needs Info" | "In Progress" | undefined {
  const requests = tree.comments.flatMap((comment) => {
    if (comment.comment_id !== comment.thread_root_comment_id) return [];
    const identified = humanActionRequest(tree, rootIssueId, comment);
    return identified ? [identified] : [];
  });
  if (requests.length === 0) return undefined;

  const active = requests.filter(({ request }) => humanActionRequestIsActive(tree, request));
  if (active.some(({ actionKind }) => actionKind !== "information")) return "Needs Approval";
  if (active.some(({ actionKind }) => actionKind === "information")) return "Needs Info";
  return "In Progress";
}

export function humanActionRequestIsActive(
  tree: LinearWorkflowTreeSnapshot,
  request: WorkflowComment,
): boolean {
  if (request.thread_state !== "resolved") return true;
  const humanReplies = tree.comments.filter((comment) =>
    comment.issue_id === request.issue_id &&
    comment.thread_root_comment_id === request.comment_id &&
    comment.parent_comment_id !== undefined &&
    comment.author_kind === "human" &&
    comment.author_user_id !== undefined &&
    comment.author_id === comment.author_user_id);
  return !humanReplies.some((humanReply) => humanCommentHasCurrentResolution(tree, humanReply));
}

export function humanCommentHasCurrentResolution(
  tree: LinearWorkflowTreeSnapshot,
  humanComment: WorkflowComment,
): boolean {
  if (
    humanComment.author_kind !== "human" ||
    humanComment.author_user_id === undefined ||
    humanComment.author_id !== humanComment.author_user_id ||
    !authorizedRootHuman(tree, humanComment.author_user_id) ||
    !hasSingleReceipt(humanComment)
  ) return false;

  const currentBodyUpdatedAt = Date.parse(humanComment.updated_at);
  if (!Number.isFinite(currentBodyUpdatedAt)) return false;
  return tree.comments.some((reply) => {
    const replyCreatedAt = Date.parse(reply.created_at);
    return reply.issue_id === humanComment.issue_id &&
      reply.parent_comment_id === humanComment.comment_id &&
      reply.thread_root_comment_id === humanComment.thread_root_comment_id &&
      reply.author_kind === "symphony" &&
      reply.body.trim().length > 0 &&
      Number.isFinite(replyCreatedAt) &&
      replyCreatedAt >= currentBodyUpdatedAt;
  });
}

function authorizedRootHuman(tree: LinearWorkflowTreeSnapshot, userId: string): boolean {
  const root = tree.issues.find(({ issue_id }) => issue_id === tree.root_issue_id);
  if (!root) return false;
  return root.creator_user_id === userId || root.assignee_user_id === userId;
}

function hasSingleReceipt(comment: WorkflowComment): boolean {
  const receipts = comment.reactions.filter(({ actor_kind, emoji }) =>
    actor_kind === "symphony" && (emoji === "✅" || emoji === "❌"));
  return receipts.length === 1;
}
