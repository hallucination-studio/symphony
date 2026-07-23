import type { LinearGatewayInterface } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RequestHumanActionDirective,
  RootReconciliationView,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type {
  HumanActionMaterializationResult,
  HumanActionMaterializerInterface,
} from "../api/HumanActionMaterializerInterface.js";

export class LinearHumanActionMaterializerImpl implements HumanActionMaterializerInterface {
  constructor(private readonly linear: LinearGatewayInterface) {}

  async materialize(input: {
    directive: RequestHumanActionDirective;
    rootDirectiveId: string;
    view: RootReconciliationView;
  }): Promise<HumanActionMaterializationResult> {
    const { directive, view } = input;
    const parentIssueId = directive.parentScope === "root"
      ? view.root.issueId
      : directive.cycleIssueId;
    if (!parentIssueId) return failed("human_action_parent_missing");
    const parent = view.tree.issues.find((issue) => issue.issue_id === parentIssueId);
    if (!parent) return failed("human_action_parent_not_found");
    const marker = `${input.rootDirectiveId}:human-action`;
    const existing = view.tree.issues.find((issue) => issue.managed_marker === marker);
    if (existing) return { kind: "materialized", actionIssueId: existing.issue_id, actionId: marker };
    const status = view.tree.status_catalog.find(({ name }) => name === "Todo");
    if (!status) return failed("human_action_status_missing");
    const body = renderDescription(directive, input.rootDirectiveId);
    const outcome = await this.linear.mutateWorkflow({
      kind: "create_workflow_issue",
      writeId: marker,
      expectedProjectId: parent.project_id,
      rootIssueId: view.root.issueId,
      expectedRootRemoteVersion: issue(view, view.root.issueId).remote_version,
      parentExpectedRemoteVersion: parent.remote_version,
      parentExpectedStatusId: parent.status_id,
      parentIssueId,
      issueKind: "human",
      title: titleFor(directive),
      description: body,
      statusId: status.status_id,
      managedMarker: marker,
      labelNames: ["Human Action", actionLabelFor(directive.actionKind)],
    });
    if (outcome.kind !== "applied" && outcome.kind !== "already_applied") return failed(`human_action_write_${outcome.kind}`);
    const readBack = await this.linear.readWorkflowIssueTree(view.root.issueId);
    const created = readBack.issues.find((candidate) => candidate.managed_marker === marker);
    return created
      ? { kind: "materialized", actionIssueId: created.issue_id, actionId: marker }
      : failed("human_action_read_back_missing");
  }
}

function titleFor(directive: RequestHumanActionDirective): string {
  const labels: Record<RequestHumanActionDirective["actionKind"], string> = {
    plan_review: "Plan review required",
    clarification: "Clarification required",
    permission: "Permission required",
    finding_waiver: "Finding waiver required",
    convergence_override: "Convergence override required",
  };
  return labels[directive.actionKind];
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

function renderDescription(directive: RequestHumanActionDirective, rootDirectiveId: string): string {
  const options = directive.options.map((option) => `- ${option}`).join("\n");
  return [
    "## Symphony Human Action",
    "",
    `Requested action: ${directive.requestedDecision}`,
    "",
    `Context: ${directive.context}`,
    "",
    "Options:",
    options || "- No options supplied",
    "",
    `Comment required: ${directive.commentRequired ? "yes" : "no"}`,
    "",
    "Move this Action to its intended terminal status after reviewing the request. Use a fresh comment to explain a rejection or answer a clarification.",
    "",
    `Source directive: ${rootDirectiveId}`,
  ].join("\n");
}

function issue(view: RootReconciliationView, issueId: string) {
  const found = view.tree.issues.find((candidate) => candidate.issue_id === issueId);
  if (!found) throw new Error("human_action_issue_missing");
  return found;
}

function failed(code: string): HumanActionMaterializationResult {
  return { kind: "failed", code, sanitizedReason: code };
}
