import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type {
  RootStateActivity,
  RootStateComment,
  RootStateFactProvenance,
  RootStateIssue,
  RootStateRelation,
  RootStateStatus,
  RootStateView,
  RootStateViewPolicyInterface,
  RootStateWorktree,
} from "../api/RootStateViewPolicyInterface.js";

export class RootStateViewPolicyImpl implements RootStateViewPolicyInterface {
  derive(state: RecoveredRootState): RootStateView {
    const issues: RootStateIssue[] = [];
    const activities: RootStateActivity[] = [];
    const comments: RootStateComment[] = [];
    const provenance: RootStateFactProvenance[] = [];
    const statuses: RootStateStatus[] = [];
    const relations: RootStateRelation[] = [];
    const worktrees: RootStateWorktree[] = [];

    for (const { identity, value, provenance: observed } of state.observation.facts) {
      provenance.push(Object.freeze({ ...identity, actorKind: observed.actorKind }));
      if (value.kind === "linear_issue") {
        issues.push(Object.freeze({ ...value, labels: Object.freeze([...value.labels]) }));
      } else if (value.kind === "linear_comment") {
        comments.push(Object.freeze({
          ...value,
          reactions: Object.freeze(value.reactions.map((reaction) => Object.freeze({ ...reaction }))),
        }));
      } else if (value.kind === "linear_activity") {
        activities.push(Object.freeze({
          ...value,
          activityKinds: Object.freeze([...value.activityKinds]),
          ...(value.addedLabelIds === undefined ? {} : { addedLabelIds: Object.freeze([...value.addedLabelIds]) }),
          ...(value.removedLabelIds === undefined ? {} : { removedLabelIds: Object.freeze([...value.removedLabelIds]) }),
        }));
      } else if (value.kind === "linear_status") {
        statuses.push(Object.freeze({ ...value }));
      } else if (value.kind === "linear_relation") {
        relations.push(Object.freeze({ ...value }));
      } else if (value.kind === "git_worktree") {
        worktrees.push(Object.freeze({ ...value, changedPaths: Object.freeze([...value.changedPaths]) }));
      }
    }

    const roots = issues.filter(({ issueId, issueKind }) => issueId === state.rootIssueId && issueKind === "root");
    if (roots.length !== 1 || worktrees.length !== 1 || worktrees[0]?.rootIssueId !== state.rootIssueId) {
      throw new Error("recovered_root_state_view_invalid");
    }

    return Object.freeze({
      rootIssueId: state.rootIssueId,
      contentDigest: state.contentDigest,
      root: roots[0]!,
      activities: Object.freeze(activities),
      comments: Object.freeze(comments),
      issues: Object.freeze(issues),
      provenance: Object.freeze(provenance),
      relations: Object.freeze(relations),
      statuses: Object.freeze(statuses),
      worktree: worktrees[0],
    });
  }
}
