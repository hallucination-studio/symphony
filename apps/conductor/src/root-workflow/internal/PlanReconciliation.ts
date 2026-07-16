import type {
  PlannedWorkflowNode,
  WorkflowNode,
} from "../api/Models.js";

export type PlanOperation =
  | { kind: "preserve"; issueId: string }
  | { kind: "cancel"; issueId: string }
  | {
      kind: "create";
      clientNodeKey: string;
      managedMarker: string;
      parentClientNodeKey?: string;
      nodeKind: "work" | "human";
      humanKind?: "planned_input";
      order: number;
      title: string;
      description: string;
      targetClientNodeKey?: string;
    }
  | {
      kind: "update";
      issueId: string;
      clientNodeKey: string;
      parentClientNodeKey?: string;
      nodeKind: "work" | "human";
      humanKind?: "planned_input";
      targetClientNodeKey?: string;
      order: number;
      title: string;
      description: string;
    };

export function reconcilePlan(input: {
  rootIssueId: string;
  turnInputHash: string;
  summary: string;
  current: WorkflowNode[];
  planned: PlannedWorkflowNode[];
}) {
  validatePlannedNodes(input.planned);
  const referenced = new Set(
    input.planned
      .map((node) => node.existingIssueId)
      .filter((issueId): issueId is string => Boolean(issueId)),
  );
  const operations: PlanOperation[] = [];
  const currentById = new Map(
    input.current.map((node) => [node.issueId, node]),
  );

  for (const current of input.current) {
    if (
      current.origin === "user" ||
      current.state === "In Review" ||
      current.state === "Done"
    ) {
      operations.push({ kind: "preserve", issueId: current.issueId });
    } else if (
      current.origin === "symphony" &&
      !referenced.has(current.issueId) &&
      current.humanKind !== "plan_approval"
    ) {
      operations.push({ kind: "cancel", issueId: current.issueId });
    }
  }

  for (const planned of input.planned) {
    if (planned.existingIssueId) {
      const existing = currentById.get(planned.existingIssueId);
      if (!existing) throw new Error("plan_existing_issue_missing");
      if (
        (existing.origin === "user" ||
          existing.state === "In Review" ||
          existing.state === "Done")
      ) {
        continue;
      }
      if (
        existing.origin !== "symphony" ||
        !["Todo", "In Progress"].includes(existing.state)
      ) {
        throw new Error("plan_existing_issue_ineligible");
      }
      const operation: PlanOperation = {
        kind: "update",
        issueId: planned.existingIssueId,
        clientNodeKey: planned.clientNodeKey,
        nodeKind: planned.kind,
        order: planned.order,
        title: titleFor(planned),
        description: planned.description,
      };
      if (planned.parentClientNodeKey) {
        operation.parentClientNodeKey = planned.parentClientNodeKey;
      }
      if (planned.kind === "human") {
        operation.humanKind = "planned_input";
        if (planned.targetClientNodeKey) {
          operation.targetClientNodeKey = planned.targetClientNodeKey;
        }
      }
      operations.push(operation);
    } else {
      const operation: PlanOperation = {
        kind: "create",
        clientNodeKey: planned.clientNodeKey,
        managedMarker: `${input.rootIssueId}:${input.turnInputHash}:${planned.clientNodeKey}`,
        nodeKind: planned.kind,
        order: planned.order,
        title: titleFor(planned),
        description: planned.description,
      };
      if (planned.parentClientNodeKey) {
        operation.parentClientNodeKey = planned.parentClientNodeKey;
      }
      if (planned.kind === "human") {
        operation.humanKind = "planned_input";
        if (planned.targetClientNodeKey) {
          operation.targetClientNodeKey = planned.targetClientNodeKey;
        }
      }
      operations.push(operation);
    }
  }
  return {
    operations,
    approval: {
      nodeKind: "human" as const,
      humanKind: "plan_approval" as const,
      title: "[Human Action] Approve Plan",
      description: input.summary,
      managedMarker: `${input.rootIssueId}:plan-approval`,
    },
  };
}

function validatePlannedNodes(nodes: PlannedWorkflowNode[]) {
  const keys = new Set(nodes.map((node) => node.clientNodeKey));
  if (keys.size !== nodes.length) throw new Error("duplicate_plan_client_node_key");
  const existingIds = nodes
    .map((node) => node.existingIssueId)
    .filter((issueId): issueId is string => Boolean(issueId));
  if (new Set(existingIds).size !== existingIds.length) {
    throw new Error("duplicate_plan_existing_issue_id");
  }
  for (const node of nodes) {
    if (node.parentClientNodeKey && !keys.has(node.parentClientNodeKey)) {
      throw new Error("plan_parent_missing");
    }
    if (
      node.kind === "human" &&
      (!node.targetClientNodeKey || !keys.has(node.targetClientNodeKey))
    ) {
      throw new Error("plan_human_target_missing");
    }
    if (node.kind === "human" && node.targetClientNodeKey) {
      const target = nodes.find(
        (candidate) => candidate.clientNodeKey === node.targetClientNodeKey,
      )!;
      if (
        target.kind !== "work" ||
        target.parentClientNodeKey !== node.parentClientNodeKey ||
        node.order >= target.order
      ) {
        throw new Error("plan_human_target_position_invalid");
      }
    }
  }
  assertAcyclic(nodes);
}

function assertAcyclic(nodes: PlannedWorkflowNode[]) {
  const byKey = new Map(nodes.map((node) => [node.clientNodeKey, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("plan_tree_cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    const parent = byKey.get(key)?.parentClientNodeKey;
    if (parent) visit(parent);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of byKey.keys()) visit(key);
}

function titleFor(node: PlannedWorkflowNode) {
  return node.kind === "human" && !node.title.startsWith("[Human Action]")
    ? `[Human Action] ${node.title}`
    : node.title;
}
