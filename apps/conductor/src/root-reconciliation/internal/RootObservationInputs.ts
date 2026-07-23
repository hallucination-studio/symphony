import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { parseManagedRecord } from "../api/index.js";
import type {
  HumanActionObservationRecord,
  ManagedRecordReference,
  RootCycleObservation,
  RootIssueKind,
  UserCommentInput,
} from "../api/RootReconciliationContracts.js";

export interface RootObservationInputs {
  cycles: RootCycleObservation[];
  pendingUserComments: UserCommentInput[];
  rootHumanActions: HumanActionObservationRecord[];
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

  const humanActions = input.tree.issues
    .filter((issue) => issue.issue_kind === "human")
    .map((issue) => humanActionRecord(issue, input.tree.issues, input.tree.relations, input.tree.root_issue_id));
  const humanActionsByCycle = new Map<string, HumanActionObservationRecord[]>();
  for (const action of humanActions) {
    if (action.parentScope !== "cycle" || !action.cycleIssueId) continue;
    const current = humanActionsByCycle.get(action.cycleIssueId) ?? [];
    current.push(action);
    humanActionsByCycle.set(action.cycleIssueId, current);
  }

  const stageResultsByCycle = new Map<string, {
    planResults: ManagedRecordReference[];
    workResults: ManagedRecordReference[];
    verifyResults: ManagedRecordReference[];
  }>();
  const stageResultIds = new Set<string>();
  for (const comment of input.tree.comments) {
    if (!comment.body.startsWith("<!-- symphony managed-record\n")) continue;
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) throw new Error(`root_managed_record_invalid:${parsed.error}`);
    if (parsed.value.kind !== "stage_result") continue;
    const record = parsed.value;
    if (record.rootIssueId !== input.tree.root_issue_id || comment.issue_id !== record.nodeIssueId || !issueById.has(record.nodeIssueId)) {
      throw new Error("root_stage_result_scope_invalid");
    }
    const node = issueById.get(record.nodeIssueId)!;
    if (node.issue_kind !== record.stage || node.parent_issue_id !== record.cycleIssueId) {
      throw new Error("root_stage_result_target_invalid");
    }
    if (stageResultIds.has(record.resultId)) throw new Error("root_stage_result_duplicate");
    stageResultIds.add(record.resultId);
    const current = stageResultsByCycle.get(record.cycleIssueId) ?? {
      planResults: [],
      workResults: [],
      verifyResults: [],
    };
    const reference = {
      recordId: record.resultId,
      recordKind: record.kind,
      version: comment.remote_version,
    };
    if (record.stage === "plan") current.planResults.push(reference);
    if (record.stage === "work") current.workResults.push(reference);
    if (record.stage === "verify") current.verifyResults.push(reference);
    stageResultsByCycle.set(record.cycleIssueId, current);
  }

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
        ...(stageResultsByCycle.get(cycleIssue.issue_id) ?? {
          planResults: [],
          workResults: [],
          verifyResults: [],
        }),
        humanActionRecords: humanActionsByCycle.get(cycleIssue.issue_id) ?? [],
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

  return {
    cycles,
    pendingUserComments,
    rootHumanActions: humanActions.filter(({ parentScope }) => parentScope === "root"),
  };
}

function humanActionRecord(
  issue: LinearWorkflowTreeSnapshot["issues"][number],
  issues: LinearWorkflowTreeSnapshot["issues"],
  relations: LinearWorkflowTreeSnapshot["relations"],
  rootIssueId: string,
): HumanActionObservationRecord {
  const parent = issue.parent_issue_id
    ? issues.find(({ issue_id }) => issue_id === issue.parent_issue_id)
    : undefined;
  const parentScope = parent?.issue_kind === "cycle" && parent.parent_issue_id === rootIssueId
    ? "cycle"
    : parent?.issue_id === rootIssueId
      ? "root"
      : undefined;
  if (!parentScope || !parent) throw new Error("root_human_action_parent_invalid");

  const actionKind = humanActionKind(issue.labels);
  const relatedIssueIds = new Set<string>();
  for (const relation of relations) {
    const relatedIssueId = relation.source_issue_id === issue.issue_id
      ? relation.target_issue_id
      : relation.target_issue_id === issue.issue_id
        ? relation.source_issue_id
        : undefined;
    if (!relatedIssueId) continue;
    const related = issues.find(({ issue_id }) => issue_id === relatedIssueId);
    if (!related || !related.issue_kind || !["plan", "work", "verify"].includes(related.issue_kind)) {
      throw new Error("root_human_action_relation_invalid");
    }
    if (parentScope === "cycle" && related.parent_issue_id !== parent.issue_id) {
      throw new Error("root_human_action_relation_scope_invalid");
    }
    relatedIssueIds.add(relatedIssueId);
  }

  return {
    actionId: issue.issue_id,
    actionIssueId: issue.issue_id,
    actionKind,
    parentScope,
    ...(parentScope === "cycle" ? { cycleIssueId: parent.issue_id } : {}),
    status: issue.status_name,
    isArchived: issue.is_archived,
    relatedIssueIds: [...relatedIssueIds].sort(),
  };
}

function humanActionKind(labels: string[]): HumanActionObservationRecord["actionKind"] {
  if (!Array.isArray(labels)) throw new Error("root_human_action_labels_missing");
  const kindByLabel: Record<string, HumanActionObservationRecord["actionKind"]> = {
    "Plan Review": "plan_review",
    Clarification: "clarification",
    Permission: "permission",
    "Finding Waiver": "finding_waiver",
    "Convergence Override": "convergence_override",
  };
  if (labels.filter((label) => label === "Human Action").length !== 1) {
    throw new Error("root_human_action_marker_invalid");
  }
  const kinds = labels
    .filter((label) => kindByLabel[label] !== undefined)
    .map((label) => kindByLabel[label]!);
  if (kinds.length !== 1) throw new Error("root_human_action_kind_invalid");
  return kinds[0]!;
}
