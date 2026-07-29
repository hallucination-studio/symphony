import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import { parseCanonicalPlanDescription } from "../../root-reconciliation/internal/CanonicalPlanDescription.js";
import type { PlanWorkNode } from "../../root-reconciliation/api/StageContracts.js";
import type {
  RootMechanicalConvergenceCompilerInput,
  RootMechanicalConvergenceCompilerInterface,
  RootMechanicalConvergenceCompilerResult,
} from "../api/RootMechanicalConvergenceCompilerInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Issue = LinearWorkflowTreeSnapshot["issues"][number];

export class ApprovedPlanDagCompilerImpl implements RootMechanicalConvergenceCompilerInterface {
  compile(input: RootMechanicalConvergenceCompilerInput): RootMechanicalConvergenceCompilerResult {
    const { target, facts, view } = input;
    if (target.kind !== "converge_approved_plan_dag" || facts.rootDigest !== view.treeDigest ||
        facts.rootSnapshot.root.issue.issueId !== view.root.issueId ||
        !isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate) ||
        !isDeepStrictEqual(facts.rootSnapshot.worktreeGate, view.worktreeGate)) return invalid("target_stale");

    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    const plan = view.tree.issues.find(({ issue_id }) => issue_id === target.planIssueId);
    const factPlan = facts.rootSnapshot.issues.find(({ issueId }) => issueId === target.planIssueId);
    if (!root || root.issue_kind !== "root" || root.parent_issue_id !== undefined || root.is_archived ||
        root.project_id !== view.root.projectId || root.status_name !== "In Progress" ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        cycle.project_id !== root.project_id || !["Planning", "Sealed"].includes(cycle.status_name) ||
        !plan || plan.issue_kind !== "plan" || plan.parent_issue_id !== cycle.issue_id || plan.is_archived ||
        plan.project_id !== root.project_id || !["Approved", "Done"].includes(plan.status_name) ||
        !factPlan || factPlan.description !== plan.description || factPlan.status !== plan.status_name ||
        digest(plan.description) !== target.planContentDigest) return invalid("topology_invalid");

    let document;
    try {
      document = parseCanonicalPlanDescription(plan.description);
    } catch {
      return invalid("topology_invalid");
    }
    if (!validCandidate(document)) return invalid("topology_invalid");

    const activeChildren = view.tree.issues.filter(({ parent_issue_id, is_archived }) =>
      parent_issue_id === cycle.issue_id && !is_archived);
    if (activeChildren.some(({ issue_kind }) => !["plan", "work", "verify"].includes(issue_kind ?? "")) ||
        activeChildren.filter(({ issue_kind }) => issue_kind === "plan").length !== 1) return invalid("topology_invalid");
    const works = activeChildren.filter(({ issue_kind }) => issue_kind === "work");
    const verifies = activeChildren.filter(({ issue_kind }) => issue_kind === "verify");
    if (works.length > document.proposedWorkDag.workNodes.length || verifies.length > 1) return invalid("topology_invalid");

    const workByIndex: Issue[] = [];
    for (let index = 0; index < document.proposedWorkDag.workNodes.length; index += 1) {
      const expected = document.proposedWorkDag.workNodes[index]!;
      const matches = works.filter(({ order }) => order === index + 1);
      if (matches.length > 1) return invalid("topology_invalid");
      const current = matches[0];
      if (!current) {
        if (works.length !== index || verifies.length > 0 || plan.status_name !== "Approved" || cycle.status_name !== "Planning") {
          return invalid("topology_invalid");
        }
        const todo = uniqueStatus(view.tree, "Todo");
        if (!todo) return invalid("status_catalog_invalid");
        return {
          kind: "effect",
          command: createNode(root, cycle, todo.status_id, "work", expected.title,
            renderWorkDescription(expected), index + 1, [plan.issue_id, "work", expected.proposalKey]),
        };
      }
      if (!matchesPlannedNode(current, cycle, "work", expected.title, renderWorkDescription(expected), index + 1)) {
        return invalid("topology_invalid");
      }
      workByIndex.push(current);
    }
    if (works.length !== workByIndex.length) return invalid("topology_invalid");

    const verifyDescription = renderVerifyDescription(document.proposedWorkDag.verifyNode);
    const verify = verifies[0];
    if (!verify) {
      if (plan.status_name !== "Approved" || cycle.status_name !== "Planning") return invalid("topology_invalid");
      const todo = uniqueStatus(view.tree, "Todo");
      if (!todo) return invalid("status_catalog_invalid");
      return {
        kind: "effect",
        command: createNode(root, cycle, todo.status_id, "verify", document.proposedWorkDag.verifyNode.title,
          verifyDescription, workByIndex.length + 1, [plan.issue_id, "verify"]),
      };
    }
    if (!matchesPlannedNode(verify, cycle, "verify", document.proposedWorkDag.verifyNode.title,
      verifyDescription, workByIndex.length + 1)) return invalid("topology_invalid");

    const keyToWork = new Map(document.proposedWorkDag.workNodes.map((node, index) => [node.proposalKey, workByIndex[index]!]));
    const expectedRelations = document.proposedWorkDag.workNodes.flatMap((node, targetIndex) =>
      node.dependencyProposalKeys.map((dependencyKey) => ({
        source: keyToWork.get(dependencyKey)!, target: workByIndex[targetIndex]!, kind: "blocks" as const,
      })));
    const activeIds = new Set([plan.issue_id, verify.issue_id, ...workByIndex.map(({ issue_id }) => issue_id)]);
    const activeRelations = view.tree.relations.filter(({ source_issue_id, target_issue_id }) =>
      activeIds.has(source_issue_id) || activeIds.has(target_issue_id));
    if (activeRelations.some((relation) => !expectedRelations.some((expected) => relation.relation_kind === expected.kind &&
      relation.source_issue_id === expected.source.issue_id && relation.target_issue_id === expected.target.issue_id)) ||
      activeRelations.some((relation, index) => activeRelations.findIndex((candidate) =>
        candidate.relation_kind === relation.relation_kind && candidate.source_issue_id === relation.source_issue_id &&
        candidate.target_issue_id === relation.target_issue_id) !== index)) return invalid("topology_invalid");

    for (const expected of expectedRelations) {
      if (activeRelations.some((relation) => relation.relation_kind === expected.kind &&
        relation.source_issue_id === expected.source.issue_id && relation.target_issue_id === expected.target.issue_id)) continue;
      return {
        kind: "effect",
        command: {
          kind: "create_workflow_relation",
          writeId: mechanicalWriteId([root.issue_id, plan.issue_id, "dependency", expected.source.issue_id, expected.target.issue_id]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          sourceIssueId: expected.source.issue_id,
          sourceExpectedRemoteVersion: expected.source.remote_version,
          targetIssueId: expected.target.issue_id,
          targetExpectedRemoteVersion: expected.target.remote_version,
          relationKind: "blocks",
          relationState: "present",
        },
      };
    }

    if (plan.status_name === "Approved") {
      const done = uniqueStatus(view.tree, "Done");
      if (!done || cycle.status_name !== "Planning") return invalid(done ? "topology_invalid" : "status_catalog_invalid");
      return { kind: "effect", command: updateNode(root, plan, cycle.issue_id, done.status_id, "plan-done") };
    }
    if (cycle.status_name === "Planning") {
      const sealed = uniqueStatus(view.tree, "Sealed");
      if (!sealed) return invalid("status_catalog_invalid");
      return { kind: "effect", command: updateNode(root, cycle, root.issue_id, sealed.status_id, "cycle-sealed") };
    }
    if (cycle.status_name !== "Sealed" || plan.status_name !== "Done") return invalid("topology_invalid");
    return {
      kind: "satisfied",
      sealDigest: digest({
        protocolVersion: 1,
        rootIssueId: root.issue_id,
        cycleIssueId: cycle.issue_id,
        planIssueId: plan.issue_id,
        planContentDigest: target.planContentDigest,
        workMapping: document.proposedWorkDag.workNodes.map((node, index) => ({
          proposalKey: node.proposalKey,
          issueId: workByIndex[index]!.issue_id,
          order: workByIndex[index]!.order,
        })),
        verify: { issueId: verify.issue_id, order: verify.order },
        relations: activeRelations.map((relation) => ({
          relationId: relation.relation_id,
          kind: relation.relation_kind,
          sourceIssueId: relation.source_issue_id,
          targetIssueId: relation.target_issue_id,
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      }),
    };
  }
}

function validCandidate(document: ReturnType<typeof parseCanonicalPlanDescription>): boolean {
  const nodes = document.proposedWorkDag.workNodes;
  if (nodes.length === 0 || document.proposedWorkDag.dependencyEdges.length !== 0) return false;
  const keys = nodes.map(({ proposalKey }) => proposalKey);
  if (new Set(keys).size !== keys.length || keys.some((key) => !key.trim())) return false;
  const dependencies = new Map(nodes.map((node) => [node.proposalKey, node.dependencyProposalKeys]));
  if (nodes.some((node) => new Set(node.dependencyProposalKeys).size !== node.dependencyProposalKeys.length ||
    node.dependencyProposalKeys.some((key) => key === node.proposalKey || !dependencies.has(key)))) return false;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    if (dependencies.get(key)!.some(cyclic)) return true;
    visiting.delete(key);
    visited.add(key);
    return false;
  };
  if (keys.some(cyclic)) return false;
  return isDeepStrictEqual(document.proposedWorkDag.verifyNode.acceptanceCriteria,
    document.planContract.acceptanceCriteria);
}

function createNode(
  root: Issue, cycle: Issue, statusId: string, kind: "work" | "verify", title: string,
  description: string, order: number, writeParts: string[],
): Extract<LinearWorkflowMutationCommand, { kind: "create_workflow_issue" }> {
  return {
    kind: "create_workflow_issue", writeId: mechanicalWriteId([root.issue_id, ...writeParts]),
    expectedProjectId: root.project_id, rootIssueId: root.issue_id, expectedRootRemoteVersion: root.remote_version,
    parentExpectedRemoteVersion: cycle.remote_version, parentExpectedStatusId: cycle.status_id,
    parentIssueId: cycle.issue_id, title, description, statusId,
    labelNames: [workflowKindLabel(kind)], order,
  };
}

function updateNode(
  root: Issue, target: Issue, parentIssueId: string, statusId: string, purpose: string,
): Extract<LinearWorkflowMutationCommand, { kind: "update_workflow_issue" }> {
  return {
    kind: "update_workflow_issue" as const,
    writeId: mechanicalWriteId([root.issue_id, target.issue_id, purpose]),
    expectedProjectId: root.project_id, rootIssueId: root.issue_id, expectedRootRemoteVersion: root.remote_version,
    target: {
      targetIssueId: target.issue_id, expectedRemoteVersion: target.remote_version,
      expectedStatusId: target.status_id, expectedParentIssueId: parentIssueId, expectedIsArchived: false as const,
    },
    statusId, title: target.title, description: target.description, labelNames: target.labels,
    parentAssignment: { mode: "retain" as const }, order: target.order,
  };
}

function matchesPlannedNode(
  issue: Issue, cycle: Issue, kind: "work" | "verify", title: string, description: string, order: number,
): boolean {
  return issue.issue_kind === kind && issue.parent_issue_id === cycle.issue_id && issue.project_id === cycle.project_id &&
    issue.status_name === "Todo" && !issue.is_archived && issue.title === title && issue.description === description &&
    issue.order === order && isDeepStrictEqual(issue.labels, [workflowKindLabel(kind)]);
}

function renderWorkDescription(node: PlanWorkNode): string {
  return [
    "# Work", "", node.description, "", "## Expected Outcome", "", node.expectedOutcome,
    "", "## Required Checks", "", ...node.requiredChecks.map((check) => `- ${check}`),
  ].join("\n");
}

function renderVerifyDescription(verify: ReturnType<typeof parseCanonicalPlanDescription>["proposedWorkDag"]["verifyNode"]): string {
  return [
    "# Verify", "", verify.title, "", "## Acceptance Criteria", "",
    ...verify.acceptanceCriteria.map(({ criterionKey, statement, verificationMethod }) =>
      `- ${criterionKey}: ${statement} (${verificationMethod})`),
    "", "## Required Checks", "", ...verify.requiredChecks.map((check) => `- ${check}`),
  ].join("\n");
}

function uniqueStatus(tree: LinearWorkflowTreeSnapshot, name: string) {
  const statuses = tree.status_catalog.filter((status) => status.name === name);
  return statuses.length === 1 ? statuses[0] : undefined;
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value), "utf8").digest("hex");
}

function invalid(reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"]): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
