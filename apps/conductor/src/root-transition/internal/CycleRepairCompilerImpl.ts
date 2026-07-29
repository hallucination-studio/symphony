import { isDeepStrictEqual } from "node:util";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import {
  currentWorkflowIssueProof,
  currentWorkflowStatusActor,
} from "../../root-reconciliation/internal/CurrentIssueProvenance.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, { kind: "converge_cycle_repair" }>;

export class CycleRepairCompilerImpl {
  compile(input: { target: Target; view: RootReconciliationView }): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    const predecessor = view.tree.issues.find(({ issue_id }) => issue_id === target.interruptedStageIssueId);
    const repair = view.tree.issues.find(({ issue_id }) => issue_id === target.repairWorkIssueId);
    const children = view.tree.issues.filter(({ parent_issue_id }) => parent_issue_id === cycle?.issue_id);
    const sourceRole = repair ? repairSourceRole(repair.description) : undefined;
    const directRepairProof = repair && currentWorkflowIssueProof({
      tree: view.tree, issue: repair, requiredActivityKinds: [],
    });
    const sourceActor = predecessor && !directRepairProof
      ? currentWorkflowStatusActor({ tree: view.tree, issue: predecessor })
      : undefined;
    const authorizedRepair = directRepairProof !== undefined || (repair !== undefined && sourceActor !== undefined &&
      currentWorkflowIssueProof({
        tree: view.tree,
        issue: repair,
        requiredActivityKinds: [],
        expectedActorId: sourceActor,
      }) !== undefined);
    if (!root || root.issue_kind !== "root" || root.status_name !== "In Progress" || root.is_archived ||
        root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
        view.tree.root_issue_id !== root.issue_id || !cycle || cycle.issue_kind !== "cycle" || cycle.is_archived ||
        cycle.parent_issue_id !== root.issue_id || !predecessor || predecessor.status_name !== "Interrupted" ||
        predecessor.parent_issue_id !== cycle.issue_id || !repair || repair.issue_kind !== "work" || repair.is_archived ||
        repair.parent_issue_id !== cycle.issue_id || repair.status_name !== "Todo" ||
        !repair.labels.includes("Cycle Repair") || !repair.labels.includes(workflowKindLabel("work")) ||
        !authorizedRepair || !sourceRole || sourceRole !== predecessor.issue_kind ||
        children.filter(({ labels, is_archived }) => !is_archived && labels.includes("Cycle Repair")).length !== 1 ||
        !validBaseDag(sourceRole, cycle.status_name, children, repair.issue_id)) return invalid("topology_invalid");

    if (sourceRole === "work") return this.compileWorkRepair({ root, predecessor, repair, view });
    return this.compileVerifyRepair({ root, cycle, predecessor, repair, children, sourceActor, view });
  }

  private compileWorkRepair(input: {
    root: LinearWorkflowTreeSnapshot["issues"][number];
    predecessor: LinearWorkflowTreeSnapshot["issues"][number];
    repair: LinearWorkflowTreeSnapshot["issues"][number];
    view: RootReconciliationView;
  }): RootMechanicalConvergenceCompilerResult {
    const { root, predecessor, repair, view } = input;
    const originalRelations = view.tree.relations.filter(({ source_issue_id, target_issue_id }) =>
      source_issue_id === predecessor.issue_id || target_issue_id === predecessor.issue_id);
    if (originalRelations.some(({ relation_kind }) => !["blocks", "blocked_by"].includes(relation_kind))) {
      return invalid("topology_invalid");
    }
    const desired = originalRelations.map((relation) => ({
        relationKind: relation.relation_kind as "blocks" | "blocked_by",
      sourceIssueId: relation.source_issue_id === predecessor.issue_id ? repair.issue_id : relation.source_issue_id,
      targetIssueId: relation.target_issue_id === predecessor.issue_id ? repair.issue_id : relation.target_issue_id,
    }));
    const repairRelations = view.tree.relations.filter(({ source_issue_id, target_issue_id }) =>
      source_issue_id === repair.issue_id || target_issue_id === repair.issue_id);
    if (repairRelations.some((relation) => !desired.some((candidate) =>
      relationMatches(relation, candidate))) || duplicateRelations(repairRelations)) return invalid("topology_invalid");
    const missing = desired.find((candidate) => !repairRelations.some((relation) => relationMatches(relation, candidate)));
    if (missing) {
      const source = view.tree.issues.find(({ issue_id }) => issue_id === missing.sourceIssueId);
      const target = view.tree.issues.find(({ issue_id }) => issue_id === missing.targetIssueId);
      if (!source || !target || source.is_archived || target.is_archived) return invalid("topology_invalid");
      return {
        kind: "effect",
        command: {
          kind: "create_workflow_relation",
          writeId: mechanicalWriteId([
            root.issue_id, predecessor.issue_id, repair.issue_id, missing.relationKind,
            missing.sourceIssueId, missing.targetIssueId,
          ]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          sourceIssueId: source.issue_id,
          sourceExpectedRemoteVersion: source.remote_version,
          targetIssueId: target.issue_id,
          targetExpectedRemoteVersion: target.remote_version,
          relationKind: missing.relationKind,
          relationState: "present",
        },
      };
    }
    if (predecessor.is_archived) return { kind: "satisfied" };
    return archiveEffect(root, predecessor, repair.issue_id, "cycle-repair-work-predecessor");
  }

  private compileVerifyRepair(input: {
    root: LinearWorkflowTreeSnapshot["issues"][number];
    cycle: LinearWorkflowTreeSnapshot["issues"][number];
    predecessor: LinearWorkflowTreeSnapshot["issues"][number];
    repair: LinearWorkflowTreeSnapshot["issues"][number];
    children: LinearWorkflowTreeSnapshot["issues"];
    sourceActor: string | undefined;
    view: RootReconciliationView;
  }): RootMechanicalConvergenceCompilerResult {
    const { root, cycle, predecessor, repair, children, sourceActor, view } = input;
    if (view.tree.relations.some(({ source_issue_id, target_issue_id }) =>
      source_issue_id === repair.issue_id || target_issue_id === repair.issue_id)) return invalid("topology_invalid");
    const successors = children.filter(({ issue_kind, labels }) =>
      issue_kind === "verify" && labels.includes("Cycle Repair Verify"));
    if (successors.length > 1) return invalid("topology_invalid");
    const successor = successors[0];
    if (!successor) {
      const todo = view.tree.status_catalog.filter(({ name }) => name === "Todo");
      if (todo.length !== 1 || predecessor.is_archived) return invalid("status_catalog_invalid");
      return {
        kind: "effect",
        command: {
          kind: "create_workflow_issue",
          writeId: mechanicalWriteId([
            root.issue_id, cycle.issue_id, predecessor.issue_id, repair.issue_id, "cycle-repair-verify",
          ]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          parentExpectedRemoteVersion: cycle.remote_version,
          parentExpectedStatusId: cycle.status_id,
          parentIssueId: cycle.issue_id,
          title: predecessor.title,
          description: predecessor.description,
          statusId: todo[0]!.status_id,
          labelNames: ["Cycle Repair Verify", workflowKindLabel("verify")],
          order: predecessor.order,
        },
      };
    }
    const directSuccessorProof = currentWorkflowIssueProof({
      tree: view.tree, issue: successor, requiredActivityKinds: [],
    });
    const authorized = directSuccessorProof !== undefined || (sourceActor !== undefined && currentWorkflowIssueProof({
      tree: view.tree,
      issue: successor,
      requiredActivityKinds: [],
      expectedActorId: sourceActor,
    }) !== undefined);
    if (successor.status_name !== "Todo" || successor.is_archived || successor.parent_issue_id !== cycle.issue_id ||
        successor.title !== predecessor.title || successor.description !== predecessor.description || !authorized ||
        !successor.labels.includes(workflowKindLabel("verify"))) return invalid("topology_invalid");
    if (!predecessor.is_archived) return archiveEffect(root, predecessor, repair.issue_id, "cycle-repair-verify-predecessor");
    if (cycle.status_name === "Executing") return { kind: "satisfied" };
    const executing = view.tree.status_catalog.filter(({ name }) => name === "Executing");
    if (executing.length !== 1 || cycle.status_name !== "Verifying") return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, repair.issue_id, "cycle-repair-executing"]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: cycle.issue_id,
          expectedRemoteVersion: cycle.remote_version,
          expectedStatusId: cycle.status_id,
          expectedParentIssueId: root.issue_id,
          expectedIsArchived: false,
        },
        statusId: executing[0]!.status_id,
        title: cycle.title,
        description: cycle.description,
        labelNames: cycle.labels,
        parentAssignment: { mode: "retain" },
        order: cycle.order,
      },
    };
  }
}

function validBaseDag(
  sourceRole: "work" | "verify",
  cycleStatus: string,
  children: LinearWorkflowTreeSnapshot["issues"],
  repairIssueId: string,
): boolean {
  const old = children.filter(({ issue_id }) => issue_id !== repairIssueId);
  const plans = old.filter(({ issue_kind }) => issue_kind === "plan");
  const works = old.filter(({ issue_kind }) => issue_kind === "work");
  const verifies = old.filter(({ issue_kind, labels }) =>
    issue_kind === "verify" && !labels.includes("Cycle Repair Verify"));
  if (plans.length !== 1 || plans[0]?.status_name !== "Done" || works.length === 0) return false;
  if (sourceRole === "work") {
    return cycleStatus === "Executing" && works.filter(({ status_name }) => status_name === "Interrupted").length === 1 &&
      works.every(({ status_name }) => ["Todo", "Done", "Interrupted"].includes(status_name)) &&
      old.filter(({ issue_kind }) => issue_kind === "verify").length === 1 &&
      old.find(({ issue_kind }) => issue_kind === "verify")?.status_name === "Todo";
  }
  return ["Verifying", "Executing"].includes(cycleStatus) &&
    old.filter(({ issue_kind, status_name }) => issue_kind === "verify" && status_name === "Interrupted").length === 1 &&
    works.every(({ status_name }) => status_name === "Done") && verifies.length <= 1;
}

function repairSourceRole(description: string): "work" | "verify" | undefined {
  const lines = description.split("\n");
  if (lines[0] !== "# Repair Objective" || !lines.includes("## Recovery Source") ||
      !lines.includes("## Acceptance Focus") || !lines.some((line) => line.startsWith("- ") && line.length > 2)) return undefined;
  for (const role of ["work", "verify"] as const) {
    if (lines.includes(`The current Cycle contains an interrupted ${role} attempt.`)) return role;
  }
  return undefined;
}

function archiveEffect(
  root: LinearWorkflowTreeSnapshot["issues"][number],
  predecessor: LinearWorkflowTreeSnapshot["issues"][number],
  repairIssueId: string,
  purpose: string,
): RootMechanicalConvergenceCompilerResult {
  return {
    kind: "effect",
    command: {
      kind: "set_workflow_issue_archive_state",
      writeId: mechanicalWriteId([root.issue_id, predecessor.issue_id, repairIssueId, purpose]),
      expectedProjectId: root.project_id,
      rootIssueId: root.issue_id,
      expectedRootRemoteVersion: root.remote_version,
      target: {
        targetIssueId: predecessor.issue_id,
        expectedRemoteVersion: predecessor.remote_version,
        expectedIsArchived: false,
      },
      isArchived: true,
    },
  };
}

function relationMatches(
  relation: LinearWorkflowTreeSnapshot["relations"][number],
  candidate: { relationKind: LinearWorkflowTreeSnapshot["relations"][number]["relation_kind"]; sourceIssueId: string; targetIssueId: string },
): boolean {
  return relation.relation_kind === candidate.relationKind && relation.source_issue_id === candidate.sourceIssueId &&
    relation.target_issue_id === candidate.targetIssueId;
}

function duplicateRelations(relations: LinearWorkflowTreeSnapshot["relations"]): boolean {
  const keys = relations.map(({ relation_kind, source_issue_id, target_issue_id }) =>
    `${relation_kind}\0${source_issue_id}\0${target_issue_id}`);
  return new Set(keys).size !== keys.length;
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
