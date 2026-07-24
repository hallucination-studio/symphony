import type { LinearGatewayInterface, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import {
  findWorkflowIssue,
  parseManagedRecord,
  renderWorkflowIssueDescription,
  serializeManagedRecord,
  workflowIssueLabel,
} from "../../root-reconciliation/api/index.js";
import type {
  HumanActionRequestRecord,
  PlanContract,
  StageResultRecord,
} from "../../root-reconciliation/api/ManagedRecords.js";
import type {
  RequestHumanActionDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type {
  HumanActionMaterializationResult,
  HumanActionMaterializerInterface,
} from "../api/HumanActionMaterializerInterface.js";

const maxDescriptionLength = 16_384;

export class LinearHumanActionMaterializerImpl implements HumanActionMaterializerInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async materialize(input: {
    directive: RequestHumanActionDirective;
    rootDirectiveId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionMaterializationResult> {
    const prepared = prepare(input);
    if (typeof prepared === "string") return failed(prepared);

    let tree = input.view.tree;
    let action = findWorkflowIssue(tree, prepared.actionId);
    if (!action) {
      if (prepared.parent.remote_version !== input.directive.expectedParentRemoteVersion) {
        return failed("human_action_parent_version_mismatch");
      }
      const status = tree.status_catalog.find(({ name }) => name === "Todo");
      if (!status) return failed("human_action_status_missing");
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_issue",
        writeId: prepared.actionId,
        expectedProjectId: prepared.parent.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: rootIssue(tree, input.view.root.issueId).remote_version,
        parentExpectedRemoteVersion: prepared.parent.remote_version,
        parentExpectedStatusId: prepared.parent.status_id,
        parentIssueId: prepared.parent.issue_id,
        title: input.directive.title,
        description: prepared.description,
        statusId: status.status_id,
        labelNames: [workflowIssueLabel("human"), actionLabelFor(input.directive.actionKind)],
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(`human_action_write_${outcome.kind}`);
      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      action = findWorkflowIssue(tree, prepared.actionId);
      if (!action) return failed("human_action_read_back_missing");
    }

    const actionError = validateAction(action, prepared, input.directive);
    if (actionError) return failed(actionError);

    for (const relatedIssueId of input.directive.relatedIssueIds) {
      const target = tree.issues.find((issue) => issue.issue_id === relatedIssueId);
      if (!target || !isValidRelatedTarget(target, prepared.parent, input.directive.parentScope, tree)) {
        return failed("human_action_related_target_invalid");
      }
      const exists = tree.relations.some((relation) =>
        relation.relation_kind === "relates_to" &&
        relation.source_issue_id === action!.issue_id &&
        relation.target_issue_id === target.issue_id,
      );
      if (exists) continue;
      const outcome = await this.linear.mutateWorkflow({
        kind: "create_workflow_relation",
        writeId: `${prepared.actionId}:related:${target.issue_id}`,
        expectedProjectId: action.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: rootIssue(tree, input.view.root.issueId).remote_version,
        sourceIssueId: action.issue_id,
        sourceExpectedRemoteVersion: action.remote_version,
        targetIssueId: target.issue_id,
        targetExpectedRemoteVersion: target.remote_version,
        relationKind: "relates_to",
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(`human_action_relation_write_${outcome.kind}`);
      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
      action = findWorkflowIssue(tree, prepared.actionId);
      if (!action) return failed("human_action_read_back_missing");
      const refreshedActionError = validateAction(action, prepared, input.directive);
      if (refreshedActionError) return failed(refreshedActionError);
    }

    const request = requestRecord(input, prepared, action);
    const requestBody = serializeManagedRecord(request);
    const existingRequests = tree.comments.flatMap((comment) => {
      const parsed = parseManagedRecord(comment.body);
      return comment.author_kind === "symphony" && parsed.ok && parsed.value.kind === "human_action_request" && parsed.value.actionId === prepared.actionId
        ? [{ comment, record: parsed.value }]
        : [];
    });
    if (existingRequests.some(({ comment }) => comment.body !== requestBody)) return failed("human_action_request_conflict");
    if (existingRequests.length === 0) {
      const outcome = await this.linear.mutateWorkflow({
        kind: "append_workflow_comment",
        writeId: `${prepared.actionId}:request`,
        expectedProjectId: action.project_id,
        rootIssueId: input.view.root.issueId,
        expectedRootRemoteVersion: rootIssue(tree, input.view.root.issueId).remote_version,
        target: {
          targetIssueId: action.issue_id,
          expectedRemoteVersion: action.remote_version,
          expectedStatusId: action.status_id,
          expectedParentIssueId: prepared.parent.issue_id,
          expectedIsArchived: false,
        },
        body: requestBody,
      });
      if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(`human_action_request_write_${outcome.kind}`);
      tree = await this.linear.readWorkflowIssueTree(input.view.root.issueId);
    }

    const confirmed = confirmMaterialization(tree, prepared, input.directive, requestBody);
    return typeof confirmed === "string"
      ? failed(confirmed)
      : { kind: "materialized", actionIssueId: confirmed.issue_id, actionId: prepared.actionId };
  }
}

interface PreparedHumanAction {
  actionId: string;
  parent: LinearWorkflowTreeSnapshot["issues"][number];
  description: string;
  createdAt: string;
}

interface PreparedPlanReview {
  plan: LinearWorkflowTreeSnapshot["issues"][number];
  contract: PlanContract;
  result: CompletedPlanResult;
}

function prepare(input: {
  directive: RequestHumanActionDirective;
  rootDirectiveId: string;
  view: RootReconciliationView;
}): PreparedHumanAction | string {
  const { directive, view } = input;
  if (directive.rootIssueId !== view.root.issueId) return "human_action_root_mismatch";
  if (!directive.title.trim() || !directive.description.trim() || !directive.requestedDecision.trim() || !directive.proposalDigest.trim()) {
    return "human_action_description_incomplete";
  }
  if (directive.relatedIssueIds.length !== new Set(directive.relatedIssueIds).size) return "human_action_related_ids_duplicate";
  const parentIssueId = directive.parentScope === "root" ? view.root.issueId : directive.cycleIssueId;
  if (!parentIssueId) return "human_action_parent_missing";
  const parent = view.tree.issues.find((issue) => issue.issue_id === parentIssueId);
  if (!parent || parent.is_archived) return "human_action_parent_not_found";
  if (directive.parentScope === "root" && parent.issue_kind !== "root") return "human_action_parent_scope_invalid";
  if (directive.parentScope === "cycle" && (parent.issue_kind !== "cycle" || parent.parent_issue_id !== view.root.issueId)) {
    return "human_action_parent_scope_invalid";
  }
  const planReview = directive.actionKind === "plan_review" ? preparePlanReview(directive, parent, view.tree, view.root.issueId) : undefined;
  if (typeof planReview === "string") return planReview;
  const actionId = `${input.rootDirectiveId}:human-action`;
  const markdown = renderDescription(directive, parent, planReview);
  const description = renderWorkflowIssueDescription({
    issueKey: actionId,
    rootIssueId: view.root.issueId,
    parentIssueId: parent.issue_id,
    issueKind: "human",
    markdown,
  });
  if (description.length > maxDescriptionLength) return "human_action_description_too_long";
  return {
    actionId,
    parent,
    description,
    createdAt: directiveAcceptedAt(view.tree, input.rootDirectiveId) ?? view.observedAt,
  };
}

function preparePlanReview(
  directive: RequestHumanActionDirective,
  cycle: LinearWorkflowTreeSnapshot["issues"][number],
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
): PreparedPlanReview | string {
  if (directive.parentScope !== "cycle" || directive.relatedIssueIds.length !== 1) return "plan_review_scope_invalid";
  const plan = tree.issues.find((issue) => issue.issue_id === directive.relatedIssueIds[0]);
  if (!plan || plan.issue_kind !== "plan" || plan.parent_issue_id !== cycle.issue_id || plan.is_archived || plan.status_name !== "In Review") {
    return "plan_review_target_invalid";
  }
  const planContracts = tree.comments.flatMap((comment) => {
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && parsed.value.kind === "plan_contract" &&
      comment.issue_id === plan.issue_id &&
      parsed.value.rootIssueId === rootIssueId &&
      parsed.value.cycleIssueId === cycle.issue_id
      ? [parsed.value]
      : [];
  });
  const contracts = planContracts.filter(({ planContractDigest }) => planContractDigest === directive.proposalDigest);
  if (contracts.length === 0 && planContracts.length > 0) return "plan_review_contract_digest_mismatch";
  if (contracts.length === 0) return "plan_review_contract_missing";
  if (contracts.length > 1) return "plan_review_contract_ambiguous";
  const result = tree.comments.flatMap((comment) => {
    const parsed = parseManagedRecord(comment.body);
    return parsed.ok && isCompletedPlanResult(parsed.value) &&
      comment.issue_id === plan.issue_id &&
      parsed.value.rootIssueId === rootIssueId &&
      parsed.value.cycleIssueId === cycle.issue_id &&
      parsed.value.nodeIssueId === plan.issue_id &&
      parsed.value.planContractDigest === directive.proposalDigest
      ? [parsed.value]
      : [];
  });
  if (result.length === 0) return "plan_review_result_missing";
  if (result.length > 1) return "plan_review_result_ambiguous";
  return { plan, contract: contracts[0]!, result: result[0]! };
}

function validateAction(
  action: LinearWorkflowTreeSnapshot["issues"][number],
  prepared: PreparedHumanAction,
  directive: RequestHumanActionDirective,
): string | undefined {
  if (action.parent_issue_id !== prepared.parent.issue_id || action.issue_kind !== "human" || action.is_archived) return "human_action_read_back_scope_invalid";
  if (!isActionStatusAllowed(directive.actionKind, action.status_name)) return "human_action_read_back_status_invalid";
  if (action.title !== directive.title || action.description !== prepared.description) return "human_action_read_back_content_invalid";
  if (action.labels.length !== 2 || !action.labels.includes("Human Action") || !action.labels.includes(actionLabelFor(directive.actionKind))) {
    return "human_action_read_back_labels_invalid";
  }
  return undefined;
}

function isActionStatusAllowed(actionKind: RequestHumanActionDirective["actionKind"], status: string): boolean {
  if (status === "Todo" || status === "In Progress" || status === "Canceled") return true;
  if (actionKind === "clarification") return status === "Answered";
  return status === "Approved" || status === "Rejected";
}

function requestRecord(
  input: { directive: RequestHumanActionDirective; rootDirectiveId: string; view: RootReconciliationView },
  prepared: PreparedHumanAction,
  action: LinearWorkflowTreeSnapshot["issues"][number],
): HumanActionRequestRecord {
  return {
    kind: "human_action_request",
    version: 1,
    actionId: prepared.actionId,
    actionIssueId: action.issue_id,
    actionKind: input.directive.actionKind,
    parentScope: input.directive.parentScope,
    rootIssueId: input.view.root.issueId,
    ...(input.directive.cycleIssueId ? { cycleIssueId: input.directive.cycleIssueId } : {}),
    relatedIssueIds: input.directive.relatedIssueIds,
    sourceRootDirectiveId: input.rootDirectiveId,
    basedOnTreeDigest: input.view.treeDigest,
    proposalDigest: input.directive.proposalDigest,
    expectedParentRemoteVersion: input.directive.expectedParentRemoteVersion,
    createdAt: prepared.createdAt,
  };
}

function confirmMaterialization(
  tree: LinearWorkflowTreeSnapshot,
  prepared: PreparedHumanAction,
  directive: RequestHumanActionDirective,
  requestBody: string,
): LinearWorkflowTreeSnapshot["issues"][number] | string {
  const action = findWorkflowIssue(tree, prepared.actionId);
  if (!action) return "human_action_read_back_missing";
  const actionError = validateAction(action, prepared, directive);
  if (actionError) return actionError;
  if (!directive.relatedIssueIds.every((relatedIssueId) => tree.relations.some((relation) =>
    relation.relation_kind === "relates_to" && relation.source_issue_id === action.issue_id && relation.target_issue_id === relatedIssueId,
  ))) return "human_action_relation_read_back_missing";
  const requests = tree.comments.filter((comment) =>
    comment.author_kind === "symphony" && comment.issue_id === action.issue_id && comment.body === requestBody,
  );
  return requests.length === 1 ? action : requests.length === 0 ? "human_action_request_read_back_missing" : "human_action_request_read_back_duplicate";
}

function isValidRelatedTarget(
  target: LinearWorkflowTreeSnapshot["issues"][number],
  parent: LinearWorkflowTreeSnapshot["issues"][number],
  parentScope: RequestHumanActionDirective["parentScope"],
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  if (target.is_archived || !["plan", "work", "verify"].includes(target.issue_kind ?? "")) return false;
  return parentScope === "root" || isDescendantOf(target, parent.issue_id, tree);
}

function isDescendantOf(
  issue: LinearWorkflowTreeSnapshot["issues"][number],
  ancestorIssueId: string,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  let parentIssueId = issue.parent_issue_id;
  const visited = new Set<string>();
  while (parentIssueId && !visited.has(parentIssueId)) {
    if (parentIssueId === ancestorIssueId) return true;
    visited.add(parentIssueId);
    parentIssueId = tree.issues.find((candidate) => candidate.issue_id === parentIssueId)?.parent_issue_id;
  }
  return false;
}

function renderDescription(
  directive: RequestHumanActionDirective,
  parent: LinearWorkflowTreeSnapshot["issues"][number],
  planReview: PreparedPlanReview | undefined,
): string {
  const target = [
    `Root: ${directive.rootIssueId}`,
    ...(directive.cycleIssueId ? [`Cycle: ${directive.cycleIssueId}`] : []),
    ...directive.relatedIssueIds.map((issueId) => `Related Issue: ${issueId}`),
  ];
  const sections = [
    "## Symphony Human Action",
    "",
    "## Requested action",
    directive.requestedDecision,
    "",
    "## What is being reviewed or requested",
    directive.description,
    "",
    "## Target",
    target.join("\n"),
    `Action parent: ${parent.identifier}`,
  ];
  if (planReview) sections.push(...planReviewSections(planReview));
  sections.push(
    "",
    "## Available outcomes",
    ...outcomeSections(directive.actionKind),
    "",
    "## Comment requirement",
    directive.commentRequired ? "A fresh comment is required before resolving this Action." : "No comment is required to approve this exact proposal. Rejection requires a fresh comment explaining why.",
    "",
    "## What happens next",
    nextSteps(directive.actionKind),
  );
  return sections.join("\n");
}

function planReviewSections(planReview: PreparedPlanReview): string[] {
  const { contract, result } = planReview;
  return [
    "",
    "## Plan Contract",
    `Objective: ${contract.objective}`,
    "",
    "Included scope:",
    list(contract.includedScope),
    "",
    "Excluded scope:",
    list(contract.excludedScope),
    "",
    "Assumptions:",
    list(contract.assumptions),
    "",
    "Constraints:",
    list(contract.constraints),
    "",
    "Acceptance criteria:",
    list(contract.acceptanceCriteria.map((criterion) => `${criterion.statement} Verification: ${criterion.verificationMethod}`)),
    "",
    "Verification requirements:",
    list(contract.verificationRequirements),
    "",
    "## Proposed execution",
    ...result.proposedWorkDag.workNodes.flatMap((work) => [
      `### ${work.title}`,
      work.description,
      `Expected outcome: ${work.expectedOutcome}`,
      `Required checks: ${work.requiredChecks.join(", ") || "None"}`,
      `Dependencies: ${work.dependencyProposalKeys.join(", ") || "None"}`,
      "",
    ]),
    `### ${result.proposedWorkDag.verifyNode.title}`,
    `Verification checks: ${result.proposedWorkDag.verifyNode.requiredChecks.join(", ") || "None"}`,
    "",
    "## Relevant proposal, evidence, and risk",
    result.summary,
    "",
    "Risks:",
    list(result.risks),
    "",
    "Required permissions:",
    list(result.requiredPermissions),
    "",
    "Evidence:",
    list(result.evidenceRefs.map((reference) => `${reference.sourceKind}: ${reference.referenceId}`)),
  ];
}

function outcomeSections(actionKind: RequestHumanActionDirective["actionKind"]): string[] {
  if (actionKind === "clarification") {
    return [
      "- Answered: provide the requested information in a fresh comment, then set this Action to Answered.",
      "- Canceled: this request is no longer needed or cannot be answered.",
    ];
  }
  return [
    "- Approved: accept this exact Plan Contract. No comment is required.",
    "- Rejected: add a fresh comment explaining why, then reject this proposal.",
    "- Canceled: this request is no longer needed or is no longer applicable.",
  ];
}

function nextSteps(actionKind: RequestHumanActionDirective["actionKind"]): string {
  if (actionKind === "plan_review") {
    return "After any terminal status, the durable Action result is sent to the Root Reconciler. It decides whether to materialize the proposed DAG, replan, request clarification, or stop. No Work or Verify Issue will be created by this Action itself.";
  }
  return "After any terminal status, the durable Action result is sent to the Root Reconciler. It decides the next directive; this Action does not directly advance execution.";
}

function list(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- None";
}

function actionLabelFor(actionKind: RequestHumanActionDirective["actionKind"]): string {
  const labels: Record<RequestHumanActionDirective["actionKind"], string> = {
    plan_review: "Plan Review",
    clarification: "Clarification",
    permission: "Permission",
    finding_waiver: "Finding Waiver",
    convergence_override: "Convergence Override",
  };
  return labels[actionKind];
}

function directiveAcceptedAt(tree: LinearWorkflowTreeSnapshot, rootDirectiveId: string): string | undefined {
  for (const comment of tree.comments) {
    const parsed = parseManagedRecord(comment.body);
    if (parsed.ok && parsed.value.kind === "root_directive" && parsed.value.rootDirectiveId === rootDirectiveId) return parsed.value.acceptedAt;
  }
  return undefined;
}

type CompletedPlanResult = StageResultRecord & {
  outcomeKind: "plan_completed";
  planContractDigest: string;
  planContract: NonNullable<StageResultRecord["planContract"]>;
  proposedWorkDag: NonNullable<StageResultRecord["proposedWorkDag"]>;
  risks: string[];
  requiredPermissions: string[];
  evidenceRefs: NonNullable<StageResultRecord["evidenceRefs"]>;
};

function isCompletedPlanResult(record: unknown): record is CompletedPlanResult {
  return typeof record === "object" && record !== null &&
    (record as StageResultRecord).kind === "stage_result" &&
    (record as StageResultRecord).stage === "plan" &&
    (record as StageResultRecord).outcomeKind === "plan_completed" &&
    (record as StageResultRecord).planContractDigest !== undefined &&
    (record as StageResultRecord).planContract !== undefined &&
    (record as StageResultRecord).proposedWorkDag !== undefined &&
    (record as StageResultRecord).risks !== undefined &&
    (record as StageResultRecord).requiredPermissions !== undefined &&
    (record as StageResultRecord).evidenceRefs !== undefined;
}

function rootIssue(tree: LinearWorkflowTreeSnapshot, rootIssueId: string) {
  const root = tree.issues.find((issue) => issue.issue_id === rootIssueId);
  if (!root) throw new Error("human_action_root_missing");
  return root;
}

function failed(code: string): HumanActionMaterializationResult {
  return { kind: "failed", code, sanitizedReason: code };
}
