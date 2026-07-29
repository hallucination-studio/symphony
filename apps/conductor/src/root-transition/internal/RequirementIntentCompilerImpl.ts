import type { RequirementIntentCompilerInterface, RequirementIntentCompilerResult } from "../api/RequirementIntentCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

export class RequirementIntentCompilerImpl implements RequirementIntentCompilerInterface {
  compile(input: Parameters<RequirementIntentCompilerInterface["compile"]>[0]): RequirementIntentCompilerResult {
    const { command, intent, view } = input;
    if (intent.semanticGate !== command.semanticGate) {
      return invalid("gate_mismatch");
    }
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id) {
      return invalid("topology_invalid");
    }
    if (command.subject.rootDefinitionVersionOrDigest !== root.remote_version) return invalid("subject_stale");
    const descendants = view.tree.issues.filter(({ issue_id }) => issue_id !== root.issue_id);
    if (command.trigger !== "initial_definition" || command.subject.activeCycleState !== "absent" ||
        root.status_name !== "Todo" || descendants.length !== 0 || view.tree.relations.length !== 0) {
      return invalid("topology_invalid");
    }
    const pendingInputIds = command.pendingInputRefs.map(({ inputId }) => inputId).sort();
    const pendingCommentInputIds = command.pendingInputRefs
      .filter(({ sourceKind }) => sourceKind === "comment_body" || sourceKind === "comment_thread_state")
      .map(({ inputId }) => inputId)
      .sort();
    if (!sameIds(intent.consumedInputIds, pendingInputIds) ||
        !sameIds(intent.commentDispositions.map(({ sourceInputId }) => sourceInputId), pendingCommentInputIds)) {
      return invalid("input_disposition_invalid");
    }
    if (intent.intent.kind === "request_information") {
      if (pendingCommentInputIds.length > 0 && !intent.commentDispositions.some(({ kind }) => kind === "needs_response")) {
        return invalid("input_disposition_invalid");
      }
      return {
        kind: "human_action_request",
        operationId: mechanicalWriteId([root.issue_id, "request-information", intent.intentId]),
        request: {
          actionKind: "information",
          targetIssueIds: [root.issue_id],
          question: intent.intent.question,
          context: intent.intent.context,
          options: intent.intent.options,
          evidenceRefs: intent.evidenceRefs,
        },
      };
    }
    if (intent.intent.kind !== "define_requirement") return invalid("gate_mismatch");
    if (intent.intent.activeCycleImpact !== "initial") return invalid("impact_invalid");
    if (intent.commentDispositions.some(({ kind }) => kind !== "applied")) return invalid("input_disposition_invalid");
    const inProgress = uniqueStatus(view, "In Progress");
    if (!inProgress) return invalid("status_catalog_invalid");
    const description = renderRequirement(intent.intent.requirement);
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, "define-requirement", description]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: root.issue_id,
          expectedRemoteVersion: root.remote_version,
          expectedStatusId: root.status_id,
          expectedIsArchived: false,
        },
        statusId: inProgress.status_id,
        title: root.title,
        description,
        labelNames: root.labels,
        parentAssignment: { mode: "retain" },
        order: root.order,
      },
    };
  }
}

function renderRequirement(requirement: {
  objective: string;
  requestedScope: string;
  constraints: string[];
  acceptanceCriteria: string[];
}): string {
  const sections = ["# Objective", "", requirement.objective.trim(), "", "## Requested Scope", "", requirement.requestedScope.trim()];
  if (requirement.constraints.length > 0) sections.push("", "## Constraints", "", ...requirement.constraints.map((value) => `- ${value.trim()}`));
  sections.push("", "## Acceptance Criteria", "", ...requirement.acceptanceCriteria.map((value) => `- ${value.trim()}`));
  return sections.join("\n");
}

function uniqueStatus(view: Parameters<RequirementIntentCompilerInterface["compile"]>[0]["view"], name: string) {
  const matches = view.tree.status_catalog.filter((status) => status.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function invalid(reason: Extract<RequirementIntentCompilerResult, { kind: "invalid_intent" }>["reason"]): RequirementIntentCompilerResult {
  return { kind: "invalid_intent", reason };
}
