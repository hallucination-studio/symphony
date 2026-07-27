import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type {
  CreateHumanActionAction,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type {
  HumanActionMaterializationResult,
  HumanActionMaterializerInterface,
} from "../api/HumanActionMaterializerInterface.js";

const headings: Record<CreateHumanActionAction["actionKind"], string> = {
  plan_approval: "需要你审批",
  information: "需要你补充信息",
  permission: "需要你授权",
  finding_waiver: "需要你确认 Finding 豁免",
};

export class LinearHumanActionMaterializerImpl implements HumanActionMaterializerInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async materialize(input: {
    action: CreateHumanActionAction;
    rootDirectiveId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionMaterializationResult> {
    const prepared = prepare(input.action, input.view);
    if (typeof prepared === "string") return failed(prepared);

    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: `${input.rootDirectiveId}:human-action-request`,
      expectedProjectId: prepared.root.project_id,
      rootIssueId: prepared.root.issue_id,
      expectedRootRemoteVersion: prepared.root.remote_version,
      target: {
        targetIssueId: prepared.root.issue_id,
        expectedRemoteVersion: prepared.root.remote_version,
        expectedStatusId: prepared.root.status_id,
        expectedIsArchived: false,
      },
      body: prepared.body,
    });
    if (outcome.kind === "precondition_conflict" || outcome.kind === "failed") {
      return failed(`human_action_request_write_${outcome.kind}`);
    }
    const readBack = outcome.kind === "write_unconfirmed" ? outcome.readBackTarget : outcome.readBack;
    const comment = readBack.comment;
    if (!comment || !matchesRequest(comment, prepared.root.issue_id, prepared.body)) {
      return failed("human_action_request_write_unconfirmed");
    }

    const tree = await this.linear.readWorkflowIssueTree(prepared.root.issue_id);
    const confirmed = tree.comments.find(({ comment_id }) => comment_id === comment.comment_id);
    if (!confirmed || !matchesRequest(confirmed, prepared.root.issue_id, prepared.body)) {
      return failed("human_action_request_read_back_invalid");
    }
    return { kind: "materialized", requestCommentId: confirmed.comment_id };
  }
}

function prepare(
  action: CreateHumanActionAction,
  view: RootReconciliationView,
): { root: LinearWorkflowTreeSnapshot["issues"][number]; body: string } | string {
  if (action.rootIssueId !== view.root.issueId) return "human_action_root_mismatch";
  const root = view.tree.issues.find(({ issue_id }) => issue_id === action.rootIssueId);
  if (!root || root.issue_kind !== "root" || root.parent_issue_id !== undefined || root.is_archived) {
    return "human_action_root_invalid";
  }
  if (root.remote_version !== action.expectedRootRemoteVersion) return "human_action_root_version_stale";
  if (!action.question.trim() || !action.context.trim()) return "human_action_request_incomplete";
  if (action.targetIssueIds.length === 0 || new Set(action.targetIssueIds).size !== action.targetIssueIds.length) {
    return "human_action_targets_invalid";
  }
  const targets = action.targetIssueIds.map((issueId) => view.tree.issues.find(({ issue_id }) => issue_id === issueId));
  if (targets.some((target) => !target || target.is_archived || !isInRoot(target, root.issue_id, view.tree))) {
    return "human_action_target_invalid";
  }
  if (action.actionKind === "plan_approval" && (targets.length !== 1 || targets[0]!.issue_kind !== "plan" || targets[0]!.status_name !== "In Review")) {
    return "human_action_plan_target_invalid";
  }
  if (action.actionKind === "finding_waiver" && targets.some((target) => !target!.labels.includes(workflowKindLabel("finding")))) {
    return "human_action_finding_target_invalid";
  }

  const body = [
    `## ${headings[action.actionKind]}`,
    "",
    action.question.trim(),
    "",
    "### 相关对象",
    ...targets.map((target) => `- ${target!.identifier}`),
    "",
    "### 背景与影响",
    action.context.trim(),
    ...(action.options.length === 0 ? [] : ["", "### 可选项", ...action.options.map((option) => `- ${option}`)]),
  ].join("\n");
  if (body.length > 16_384 || /```json|<!--|\0/u.test(body)) return "human_action_request_content_invalid";
  return { root, body };
}

function isInRoot(
  issue: LinearWorkflowTreeSnapshot["issues"][number] | undefined,
  rootIssueId: string,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (!issue) return false;
  if (issue.issue_id === rootIssueId) return true;
  const visited = new Set<string>();
  let parentIssueId = issue.parent_issue_id;
  while (parentIssueId && !visited.has(parentIssueId)) {
    if (parentIssueId === rootIssueId) return true;
    visited.add(parentIssueId);
    parentIssueId = tree.issues.find(({ issue_id }) => issue_id === parentIssueId)?.parent_issue_id;
  }
  return false;
}

function matchesRequest(
  comment: LinearWorkflowTreeSnapshot["comments"][number],
  rootIssueId: string,
  body: string,
): boolean {
  return comment.issue_id === rootIssueId &&
    comment.parent_comment_id === undefined &&
    comment.thread_root_comment_id === comment.comment_id &&
    comment.author_kind === "symphony" &&
    comment.body === body;
}

function failed(code: string): HumanActionMaterializationResult {
  return { kind: "failed", code, sanitizedReason: code };
}
