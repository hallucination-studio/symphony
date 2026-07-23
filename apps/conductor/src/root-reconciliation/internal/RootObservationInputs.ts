import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootCycleObservation,
  RootIssueKind,
  UserCommentInput,
} from "../api/RootReconciliationContracts.js";

export interface RootObservationInputs {
  cycles: RootCycleObservation[];
  pendingUserComments: UserCommentInput[];
}

export function buildRootObservationInputs(input: {
  tree: LinearWorkflowTreeSnapshot;
  handledCommentVersions?: ReadonlySet<string>;
}): RootObservationInputs {
  const issueById = new Map(input.tree.issues.map((issue) => [issue.issue_id, issue]));
  if (issueById.size !== input.tree.issues.length) throw new Error("root_tree_duplicate_issue");

  const cycleForIssue = (issueId: string): string | undefined => {
    let current = issueById.get(issueId);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.issue_id)) throw new Error("root_tree_parent_cycle");
      visited.add(current.issue_id);
      if (current.issue_kind === "cycle") return current.issue_id;
      if (!current.parent_issue_id) return undefined;
      current = issueById.get(current.parent_issue_id);
      if (!current) throw new Error("root_tree_parent_missing");
    }
    return undefined;
  };

  const cycles = input.tree.issues
    .filter((issue) => issue.issue_kind === "cycle")
    .map((cycleIssue) => {
      const scope = new Set(
        input.tree.issues
          .filter((issue) => cycleForIssue(issue.issue_id) === cycleIssue.issue_id)
          .map((issue) => issue.issue_id),
      );
      scope.add(cycleIssue.issue_id);
      return {
        cycleIssue,
        isArchived: cycleIssue.is_archived,
        issues: input.tree.issues.filter((issue) => scope.has(issue.issue_id) && issue.issue_id !== cycleIssue.issue_id),
        relations: input.tree.relations.filter((relation) =>
          scope.has(relation.source_issue_id) && scope.has(relation.target_issue_id)),
        comments: input.tree.comments.filter((comment) => scope.has(comment.issue_id)),
      };
    });

  const handled = input.handledCommentVersions ?? new Set<string>();
  const pendingUserComments = input.tree.comments.flatMap((comment) => {
    const issue = issueById.get(comment.issue_id);
    if (!issue) throw new Error("root_comment_issue_missing");
    if (!issue.issue_kind) throw new Error("root_comment_issue_kind_missing");
    const versionKey = `${comment.comment_id}:${comment.remote_version}`;
    if (handled.has(versionKey) || comment.managed_marker || comment.author_kind !== "human") return [];
    if (!comment.author_user_id || comment.author_id !== comment.author_user_id) {
      throw new Error("root_user_comment_actor_missing");
    }
    const cycleIssueId = cycleForIssue(issue.issue_id);
    return [{
      commentId: comment.comment_id,
      commentVersion: comment.remote_version,
      issueId: comment.issue_id,
      issueKind: issue.issue_kind as RootIssueKind,
      ...(cycleIssueId ? { cycleIssueId } : {}),
      authorUserId: comment.author_user_id,
      body: comment.body,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    }];
  });

  return { cycles, pendingUserComments };
}
