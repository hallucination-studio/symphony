import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import { rootInputId } from "../../root-reconciliation/internal/RootInputIdentity.js";
import type {
  TerminalSuccessorCompilerInterface,
  TerminalSuccessorCompilerResult,
} from "../api/TerminalSuccessorCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

export class TerminalSuccessorCompilerImpl implements TerminalSuccessorCompilerInterface {
  compile(input: Parameters<TerminalSuccessorCompilerInterface["compile"]>[0]): TerminalSuccessorCompilerResult {
    const { command, intent, view, convergence } = input;
    if (intent.semanticGate !== command.semanticGate) return invalid("gate_mismatch");
    if (intent.intent.kind !== "start_successor_cycle") return invalid("purpose_incompatible");
    if (!hasExactInputCoverage(command.pendingInputRefs, intent.consumedInputIds, intent.commentDispositions)) {
      return invalid("input_disposition_invalid");
    }
    if (intent.basedOnTargetRootDigest !== view.treeDigest || view.worktreeGate.kind !== "valid" ||
        command.subject.exactRevision !== view.worktreeGate.headRevision) return invalid("subject_stale");

    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycles = view.tree.issues
      .filter(({ issue_kind, parent_issue_id }) => issue_kind === "cycle" && parent_issue_id === root?.issue_id)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || compareCodePoints(left.issue_id, right.issue_id));
    const predecessor = cycles.at(-1);
    const cycleLimitReached = cycles.length >= convergence.policy.maxCyclesPerRoot;
    const observedAt = Date.parse(view.tree.observed_at);
    const deadlineAt = Date.parse(convergence.policy.deadlineAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(deadlineAt) ||
        convergence.view.isDeadlineExceeded !== (observedAt >= deadlineAt)) return invalid("subject_stale");
    const successorCyclePolicy = convergence.view.isDeadlineExceeded
      ? "root_deadline_reached"
      : cycleLimitReached ? "cycle_limit_reached" : "allowed";
    if (convergence.view.cycleCount !== cycles.length || convergence.view.activeCycleIssueId !== undefined ||
        command.subject.successorCyclePolicy !== successorCyclePolicy) {
      return invalid("subject_stale");
    }
    if (successorCyclePolicy !== "allowed") return invalid("successor_prohibited");
    if (command.trigger !== "cycle_terminal" || command.subject.cycleOutcome !== "successful" ||
        command.subject.verifyClassification !== "passed" || command.subject.findingClassification !== "none_open" ||
        predecessor?.issue_id !== command.subject.terminalCycleIssueId ||
        predecessor.remote_version !== command.subject.terminalCycleVersionOrDigest) return invalid("subject_stale");
    if (!root || root.issue_kind !== "root" || root.status_name !== "In Progress" || root.is_archived ||
        root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
        view.tree.root_issue_id !== root.issue_id || !predecessor || predecessor.issue_kind !== "cycle" ||
        predecessor.parent_issue_id !== root.issue_id || predecessor.project_id !== root.project_id ||
        predecessor.status_name !== "Succeeded" || predecessor.is_archived ||
        cycles.slice(0, -1).some(({ is_archived }) => !is_archived)) return invalid("topology_invalid");

    const planning = uniqueStatus(view.tree, "Planning");
    if (!planning) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "create_workflow_issue",
        writeId: mechanicalWriteId([
          root.issue_id, predecessor.issue_id, predecessor.remote_version, "terminal-review-successor", intent.intentId,
        ]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        parentExpectedRemoteVersion: root.remote_version,
        parentExpectedStatusId: root.status_id,
        parentIssueId: root.issue_id,
        title: `Cycle ${cycles.length + 1}`,
        description: renderTerminalSuccessorCycle(
          intent.intent.successorObjective,
          intent.intent.requiredOutcomes,
          intent.intent.preservedConstraints,
        ),
        statusId: planning.status_id,
        labelNames: ["Terminal Review Successor", workflowKindLabel("cycle")],
      },
    };
  }
}

function renderTerminalSuccessorCycle(
  objective: string,
  requiredOutcomes: string[],
  preservedConstraints: string[],
): string {
  return [
    "# Successor Objective", "", objective.trim(), "",
    "## Required Outcomes", "", ...requiredOutcomes.map((outcome) => `- ${outcome.trim()}`), "",
    "## Preserved Constraints", "", ...preservedConstraints.map((constraint) => `- ${constraint.trim()}`),
  ].join("\n");
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const matches = tree.status_catalog.filter((status) => status.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort(compareCodePoints)
    .every((value, index) => value === [...right].sort(compareCodePoints)[index]);
}

function hasExactInputCoverage(
  pending: Parameters<TerminalSuccessorCompilerInterface["compile"]>[0]["command"]["pendingInputRefs"],
  consumedInputIds: string[],
  dispositions: Parameters<TerminalSuccessorCompilerInterface["compile"]>[0]["intent"]["commentDispositions"],
): boolean {
  if (new Set(consumedInputIds).size !== consumedInputIds.length ||
      new Set(dispositions.map(({ sourceInputId }) => sourceInputId)).size !== dispositions.length ||
      !sameIds(consumedInputIds, pending.map(({ inputId }) => inputId))) return false;
  const pendingComments = pending.filter(({ sourceKind }) =>
    sourceKind === "comment_body" || sourceKind === "comment_thread_state");
  if (!sameIds(dispositions.map(({ sourceInputId }) => sourceInputId), pendingComments.map(({ inputId }) => inputId))) {
    return false;
  }
  return dispositions.every((disposition) => {
    const source = pendingComments.find(({ inputId }) => inputId === disposition.sourceInputId);
    if (!source || source.sourceKind !== disposition.source.kind ||
        source.nativeSourceIdentity !== disposition.source.commentId) return false;
    return disposition.source.kind === "comment_body"
      ? source.sourceVersionOrDigest === disposition.source.commentBodyDigest
      : disposition.sourceInputId === rootInputId(
        `comment_thread_state:${disposition.source.commentId}:${disposition.source.threadRootCommentId}:${disposition.source.threadState}`,
        source.sourceVersionOrDigest,
      );
  });
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<TerminalSuccessorCompilerResult, { kind: "invalid_intent" }>["reason"],
): TerminalSuccessorCompilerResult {
  return { kind: "invalid_intent", reason };
}
