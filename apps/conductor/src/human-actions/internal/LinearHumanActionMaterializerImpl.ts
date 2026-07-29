import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import {
  humanActionHeadings,
  humanActionRequestIsActive,
  humanActionSummaryStatus,
} from "../api/HumanActionSummary.js";
import type {
  HumanActionMaterializationResult,
  HumanActionMaterializerInterface,
  HumanActionRequest,
  HumanActionSummaryConvergenceResult,
} from "../api/HumanActionMaterializerInterface.js";

export class LinearHumanActionMaterializerImpl implements HumanActionMaterializerInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async materialize(input: {
    request: HumanActionRequest;
    operationId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionMaterializationResult> {
    const prepared = prepare(input.request, input.view);
    if (typeof prepared === "string") return failed(prepared);

    const initialMatches = matchingRequests(input.view.tree, prepared.root.issue_id, prepared.body);
    if (initialMatches.length > 1) return failed("human_action_request_ambiguous");
    let writeOutcome: Awaited<ReturnType<LinearGatewayInterface["mutateWorkflow"]>> | undefined;
    if (initialMatches.length === 0) {
      writeOutcome = await this.linear.mutateWorkflow({
        kind: "append_workflow_comment",
        writeId: `${input.operationId}:human-action-request`,
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
    }

    let tree = await this.linear.readWorkflowIssueTree(prepared.root.issue_id);
    const confirmed = matchingRequests(tree, prepared.root.issue_id, prepared.body);
    if (confirmed.length !== 1) {
      if (confirmed.length > 1) return failed("human_action_request_ambiguous");
      if (writeOutcome?.kind === "precondition_conflict" || writeOutcome?.kind === "failed") {
        return failed(`human_action_request_write_${writeOutcome.kind}`);
      }
      return failed("human_action_request_write_unconfirmed");
    }

    const statusResult = await convergeHumanActionRootStatus(this.linear, tree, prepared.root.issue_id, input.operationId);
    if (typeof statusResult === "string") return failed(statusResult);
    tree = statusResult;
    const request = tree.comments.find(({ comment_id }) => comment_id === confirmed[0]!.comment_id);
    if (!request || !matchesRequest(request, prepared.root.issue_id, prepared.body)) {
      return failed("human_action_request_read_back_invalid");
    }
    return { kind: "materialized", requestCommentId: request.comment_id };
  }

  async convergeRootSummary(input: {
    operationId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionSummaryConvergenceResult> {
    const desiredStatus = humanActionSummaryStatus(input.view.tree, input.view.root.issueId);
    if (!desiredStatus) return { kind: "not_applicable" as const };
    const root = input.view.tree.issues.find(({ issue_id }) => issue_id === input.view.root.issueId);
    if (root?.status_name === desiredStatus) return { kind: "satisfied" as const };
    const result = await convergeHumanActionRootStatus(
      this.linear,
      input.view.tree,
      input.view.root.issueId,
      input.operationId,
    );
    return typeof result === "string"
      ? { kind: "failed", code: result, sanitizedReason: result }
      : { kind: "materialized" as const, desiredStatus };
  }
}

function prepare(
  request: HumanActionRequest,
  view: RootReconciliationView,
): { root: LinearWorkflowTreeSnapshot["issues"][number]; body: string } | string {
  const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
  if (!root || root.issue_kind !== "root" || root.parent_issue_id !== undefined || root.is_archived) {
    return "human_action_root_invalid";
  }
  if (!request.question.trim() || !request.context.trim()) return "human_action_request_incomplete";
  if (request.targetIssueIds.length === 0 || new Set(request.targetIssueIds).size !== request.targetIssueIds.length) {
    return "human_action_targets_invalid";
  }
  const targets = request.targetIssueIds.map((issueId) => view.tree.issues.find(({ issue_id }) => issue_id === issueId));
  if (targets.some((target) => !target || target.is_archived || !isInRoot(target, root.issue_id, view.tree))) {
    return "human_action_target_invalid";
  }
  if (request.actionKind === "plan_approval" && (targets.length !== 1 || targets[0]!.issue_kind !== "plan" || targets[0]!.status_name !== "In Review")) {
    return "human_action_plan_target_invalid";
  }
  if (request.actionKind === "finding_waiver" && targets.some((target) => !target!.labels.includes(workflowKindLabel("finding")))) {
    return "human_action_finding_target_invalid";
  }
  const waiverContext = request.actionKind === "finding_waiver"
    ? findingWaiverContext(targets as LinearWorkflowTreeSnapshot["issues"], view.tree)
    : [];
  if (request.actionKind === "finding_waiver" && typeof waiverContext === "string") return waiverContext;

  const body = [
    `## ${humanActionHeadings[request.actionKind]}`,
    "",
    "### 需要你的操作",
    request.question.trim(),
    "",
    "### 相关对象",
    ...targets.map((target) => `- ${target!.identifier}`),
    ...(Array.isArray(waiverContext) && waiverContext.length > 0
      ? ["", "### Verify 与 Cycle", ...waiverContext.map((target) => `- ${target.identifier}`)]
      : []),
    "",
    "### 背景与影响",
    request.context.trim(),
    ...(request.options.length === 0 ? [] : ["", "### 可选项", ...request.options.map((option) => `- ${option}`)]),
    "",
    "### 如何继续",
    request.actionKind === "information"
      ? "请直接在本条 comment 下回复并提供上述信息。"
      : "请直接在本条 comment 下回复你的决定。",
    "",
    "### 回复后",
    "Symphony 会验证回复与相关对象的当前事实，并在确认后继续。",
  ].join("\n");
  if (body.length > 16_384 || /```json|<!--|\0/u.test(body)) return "human_action_request_content_invalid";
  return { root, body };
}

function findingWaiverContext(
  findings: LinearWorkflowTreeSnapshot["issues"],
  tree: LinearWorkflowTreeSnapshot,
): LinearWorkflowTreeSnapshot["issues"] | string {
  const cycleIds = new Set(findings.map(({ parent_issue_id }) => parent_issue_id));
  if (cycleIds.size !== 1) return "human_action_finding_cycle_invalid";
  const cycleId = [...cycleIds][0];
  const cycle = tree.issues.find(({ issue_id, issue_kind, is_archived }) =>
    issue_id === cycleId && issue_kind === "cycle" && !is_archived);
  if (!cycle) return "human_action_finding_cycle_invalid";
  const findingIds = new Set(findings.map(({ issue_id }) => issue_id));
  const verifies = tree.issues.filter(({ issue_kind, parent_issue_id, is_archived, labels }) =>
    issue_kind === "verify" && parent_issue_id === cycle.issue_id && !is_archived && labels.includes("Changes Required"));
  const verify = verifies.length === 1 ? verifies[0] : undefined;
  if (!verify || findings.some((finding) => !tree.relations.some(({ relation_kind, source_issue_id, target_issue_id }) =>
    relation_kind === "relates_to" && source_issue_id === finding.issue_id && target_issue_id === verify.issue_id)) ||
      tree.relations.some(({ relation_kind, source_issue_id, target_issue_id }) =>
        relation_kind === "relates_to" && findingIds.has(source_issue_id) && target_issue_id !== verify.issue_id &&
        tree.issues.some(({ issue_id, issue_kind }) => issue_id === target_issue_id && issue_kind === "verify"))) {
    return "human_action_finding_verify_invalid";
  }
  return [verify, cycle];
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

function matchingRequests(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  body: string,
): LinearWorkflowTreeSnapshot["comments"] {
  return tree.comments.filter((comment) =>
    matchesRequest(comment, rootIssueId, body) && humanActionRequestIsActive(tree, comment));
}

export async function convergeHumanActionRootStatus(
  linear: LinearGatewayInterface,
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  operationId: string,
): Promise<LinearWorkflowTreeSnapshot | string> {
  const desiredStatus = humanActionSummaryStatus(tree, rootIssueId);
  if (!desiredStatus) return "human_action_root_summary_invalid";
  const root = tree.issues.find(({ issue_id }) => issue_id === rootIssueId);
  if (!root || root.issue_kind !== "root" || root.is_archived) return "human_action_root_invalid";
  if (root.status_name === desiredStatus) return tree;
  if (!["In Progress", "Needs Approval", "Needs Info"].includes(root.status_name)) {
    return "human_action_root_status_invalid";
  }
  const status = tree.status_catalog.find(({ name }) => name === desiredStatus);
  if (!status) return "human_action_root_status_missing";

  const outcome = await linear.mutateWorkflow({
    kind: "update_workflow_issue",
    writeId: `${operationId}:human-action-root-status`,
    expectedProjectId: root.project_id,
    rootIssueId,
    expectedRootRemoteVersion: root.remote_version,
    target: {
      targetIssueId: root.issue_id,
      expectedRemoteVersion: root.remote_version,
      expectedStatusId: root.status_id,
      expectedIsArchived: false,
    },
    statusId: status.status_id,
    title: root.title,
    description: root.description,
    labelNames: root.labels,
    parentAssignment: { mode: "retain" },
    order: root.order,
  });
  const readBack = await linear.readWorkflowIssueTree(rootIssueId);
  const confirmed = readBack.issues.find(({ issue_id }) => issue_id === rootIssueId);
  if (!confirmed || confirmed.status_id !== status.status_id || confirmed.status_name !== status.name) {
    return outcome.kind === "applied" || outcome.kind === "already_applied"
      ? "human_action_root_status_read_back_invalid"
      : "human_action_root_status_write_failed";
  }
  return readBack;
}

function failed(code: string): HumanActionMaterializationResult {
  return { kind: "failed", code, sanitizedReason: code };
}
