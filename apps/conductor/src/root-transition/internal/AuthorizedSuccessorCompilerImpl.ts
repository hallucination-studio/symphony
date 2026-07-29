import { isDeepStrictEqual } from "node:util";

import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import { currentWorkflowIssueProof, currentWorkflowStatusActor } from "../../root-reconciliation/internal/CurrentIssueProvenance.js";
import type {
  RootMechanicalConvergenceCompilerInput,
  RootMechanicalConvergenceCompilerInterface,
  RootMechanicalConvergenceCompilerResult,
} from "../api/RootMechanicalConvergenceCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

export class AuthorizedSuccessorCompilerImpl implements RootMechanicalConvergenceCompilerInterface {
  compile(input: RootMechanicalConvergenceCompilerInput): RootMechanicalConvergenceCompilerResult {
    const { target, facts, view } = input;
    if (target.kind !== "converge_authorized_successor" || facts.rootDigest !== view.treeDigest ||
        facts.rootSnapshot.root.issue.issueId !== view.root.issueId ||
        !isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate) ||
        !isDeepStrictEqual(facts.rootSnapshot.worktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const predecessor = view.tree.issues.find(({ issue_id }) => issue_id === target.predecessorCycleIssueId);
    const successor = view.tree.issues.find(({ issue_id }) => issue_id === target.successorCycleIssueId);
    const cycles = view.tree.issues
      .filter(({ issue_kind, parent_issue_id }) => issue_kind === "cycle" && parent_issue_id === root?.issue_id)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || compareCodePoints(left.issue_id, right.issue_id));
    const canonicalPredecessor = cycles.at(-2);
    const canonicalSuccessor = cycles.at(-1);
    if (canonicalPredecessor?.issue_id !== target.predecessorCycleIssueId ||
        canonicalSuccessor?.issue_id !== target.successorCycleIssueId) return invalid("target_stale");
    let authorized = successor && view.tree.source_manifest.some((source) =>
      source.source_kind === "linear_issue" && source.source_id === successor.issue_id &&
      source.source_version === successor.remote_version && source.actor_kind === "symphony");
    if (target.authorizationKind === "stage_recovery" && predecessor && successor) {
      const source = interruptedExecutionStage(predecessor.status_name, predecessor.issue_id, view.tree.issues);
      const directProof = currentWorkflowIssueProof({ tree: view.tree, issue: successor, requiredActivityKinds: [] });
      const sourceActor = source && !directProof ? currentWorkflowStatusActor({ tree: view.tree, issue: source }) : undefined;
      authorized = directProof !== undefined || (sourceActor !== undefined && currentWorkflowIssueProof({
        tree: view.tree,
        issue: successor,
        requiredActivityKinds: [],
        expectedActorId: sourceActor,
      }) !== undefined);
    } else if (target.authorizationKind === "delivery_recovery" && root && successor) {
      const directProof = currentWorkflowIssueProof({ tree: view.tree, issue: successor, requiredActivityKinds: [] });
      const sourceActor = !directProof ? currentWorkflowStatusActor({ tree: view.tree, issue: root }) : undefined;
      authorized = directProof !== undefined || (sourceActor !== undefined && currentWorkflowIssueProof({
        tree: view.tree,
        issue: successor,
        requiredActivityKinds: [],
        expectedActorId: sourceActor,
      }) !== undefined);
    } else if (target.authorizationKind === "terminal_review" && predecessor && successor) {
      const directProof = currentWorkflowIssueProof({ tree: view.tree, issue: successor, requiredActivityKinds: [] });
      const sourceActor = !directProof ? currentWorkflowStatusActor({ tree: view.tree, issue: predecessor }) : undefined;
      authorized = directProof !== undefined || (sourceActor !== undefined && currentWorkflowIssueProof({
        tree: view.tree,
        issue: successor,
        requiredActivityKinds: [],
        expectedActorId: sourceActor,
      }) !== undefined);
    }
    const authorizationLabel = target.authorizationKind === "delivery_recovery"
      ? "Delivery Recovery"
      : target.authorizationKind === "terminal_review"
        ? "Terminal Review Successor"
        : "Interrupted Stage Recovery";
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        !predecessor || predecessor.issue_kind !== "cycle" || predecessor.parent_issue_id !== root.issue_id ||
        !successor || successor.issue_kind !== "cycle" || successor.parent_issue_id !== root.issue_id ||
        successor.status_name !== "Planning" || successor.is_archived ||
        !successor.labels.includes(authorizationLabel) || !authorized ||
        cycles.slice(0, -2).some(({ is_archived }) => !is_archived)) return invalid("topology_invalid");
    if (target.authorizationKind === "stage_recovery") {
      if (!hasInterruptedExecutionStage(predecessor.issue_id, view.tree.issues)) return invalid("topology_invalid");
    } else if (predecessor.status_name !== "Succeeded") {
      return invalid("topology_invalid");
    }
    if (root.status_name === "In Review") {
      if (target.authorizationKind !== "delivery_recovery") return invalid("topology_invalid");
      const inProgress = view.tree.status_catalog.filter(({ name }) => name === "In Progress");
      if (inProgress.length !== 1) return invalid("status_catalog_invalid");
      return {
        kind: "effect",
        command: {
          kind: "update_workflow_issue",
          writeId: mechanicalWriteId([
            root.issue_id, predecessor.issue_id, successor.issue_id, target.authorizationKind, "resume-root",
          ]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          target: {
            targetIssueId: root.issue_id,
            expectedRemoteVersion: root.remote_version,
            expectedStatusId: root.status_id,
            expectedIsArchived: false,
          },
          statusId: inProgress[0]!.status_id,
          title: root.title,
          description: root.description,
          labelNames: root.labels,
          parentAssignment: { mode: "retain" },
          order: root.order,
        },
      };
    }
    if (root.status_name !== "In Progress") return invalid("topology_invalid");
    const archiveTarget = view.tree.issues
      .filter((issue) => !issue.is_archived && issue.issue_id !== predecessor.issue_id &&
        isDescendantOf(issue.issue_id, predecessor.issue_id, view.tree.issues))
      .sort((left, right) => right.depth - left.depth || compareCodePoints(left.issue_id, right.issue_id))[0];
    if (archiveTarget || !predecessor.is_archived) {
      const targetIssue = archiveTarget ?? predecessor;
      return {
        kind: "effect",
        command: {
          kind: "set_workflow_issue_archive_state",
          writeId: mechanicalWriteId([
            root.issue_id, predecessor.issue_id, successor.issue_id, target.authorizationKind,
            "archive-predecessor", targetIssue.issue_id,
          ]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          target: {
            targetIssueId: targetIssue.issue_id,
            expectedRemoteVersion: targetIssue.remote_version,
            expectedIsArchived: false,
          },
          isArchived: true,
        },
      };
    }
    const plans = view.tree.issues.filter(({ issue_kind, parent_issue_id, is_archived }) =>
      issue_kind === "plan" && parent_issue_id === successor.issue_id && !is_archived);
    if (plans.length === 1 && plans[0]!.status_name === "Todo") return { kind: "satisfied" };
    if (plans.length !== 0) return invalid("topology_invalid");
    const todo = view.tree.status_catalog.filter(({ name }) => name === "Todo");
    if (todo.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "create_workflow_issue",
        writeId: mechanicalWriteId([
          root.issue_id, predecessor.issue_id, successor.issue_id, target.authorizationKind, "successor-plan",
        ]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        parentExpectedRemoteVersion: successor.remote_version,
        parentExpectedStatusId: successor.status_id,
        parentIssueId: successor.issue_id,
        title: "Plan",
        description: successor.description,
        statusId: todo[0]!.status_id,
        labelNames: [workflowKindLabel("plan")],
      },
    };
  }
}

function hasInterruptedExecutionStage(
  cycleIssueId: string,
  issues: Parameters<AuthorizedSuccessorCompilerImpl["compile"]>[0]["view"]["tree"]["issues"],
): boolean {
  const cycle = issues.find(({ issue_id }) => issue_id === cycleIssueId);
  const active = issues.filter(({ parent_issue_id, is_archived }) => parent_issue_id === cycleIssueId && !is_archived);
  const children = issues.filter(({ parent_issue_id }) => parent_issue_id === cycleIssueId);
  if (!cycle || !interruptedExecutionStage(cycle.status_name, cycleIssueId, issues)) return false;
  if (cycle?.status_name === "Executing") {
    return children.filter(({ issue_kind, status_name }) => issue_kind === "work" && status_name === "Interrupted").length === 1 &&
      active.every(({ issue_kind, status_name }) => issue_kind !== "work" || status_name !== "In Progress");
  }
  if (cycle?.status_name === "Verifying") {
    return children.filter(({ issue_kind, status_name }) => issue_kind === "verify" && status_name === "Interrupted").length === 1 &&
      children.filter(({ issue_kind }) => issue_kind === "verify").length === 1 &&
      children.filter(({ issue_kind }) => issue_kind === "work").every(({ status_name }) => status_name === "Done");
  }
  return false;
}

function interruptedExecutionStage(
  cycleStatus: string,
  cycleIssueId: string,
  issues: Parameters<AuthorizedSuccessorCompilerImpl["compile"]>[0]["view"]["tree"]["issues"],
): Parameters<AuthorizedSuccessorCompilerImpl["compile"]>[0]["view"]["tree"]["issues"][number] | undefined {
  const role = cycleStatus === "Executing" ? "work" : cycleStatus === "Verifying" ? "verify" : undefined;
  if (!role) return undefined;
  const interrupted = issues.filter(({ parent_issue_id, issue_kind, status_name }) =>
    parent_issue_id === cycleIssueId && issue_kind === role && status_name === "Interrupted");
  return interrupted.length === 1 ? interrupted[0] : undefined;
}

function isDescendantOf(
  issueId: string,
  ancestorIssueId: string,
  issues: Parameters<AuthorizedSuccessorCompilerImpl["compile"]>[0]["view"]["tree"]["issues"],
): boolean {
  const visited = new Set<string>();
  let current = issues.find(({ issue_id }) => issue_id === issueId);
  while (current?.parent_issue_id && !visited.has(current.issue_id)) {
    if (current.parent_issue_id === ancestorIssueId) return true;
    visited.add(current.issue_id);
    current = issues.find(({ issue_id }) => issue_id === current!.parent_issue_id);
  }
  return false;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
