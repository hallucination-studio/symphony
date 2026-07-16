import type { RootAction, WorkflowNode } from "../../root-workflow/api/Models.js";

export function selectWorkflowLeaf(nodes: WorkflowNode[]): RootAction {
  const activeLeaves = nodes.filter(
    (node) =>
      node.state === "In Progress" &&
      !hasChildren(node.issueId, nodes) &&
      node.humanKind !== "plan_approval",
  );
  if (activeLeaves.length > 1) {
    return { kind: "blocked_root", reason: "multiple_active_leaves" };
  }
  const childrenByParent = new Map<string | null, WorkflowNode[]>();
  for (const node of nodes) {
    const siblings = childrenByParent.get(node.parentIssueId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentIssueId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    const activeOrders = siblings
      .filter((node) => node.state !== "Canceled")
      .map((node) => node.siblingOrder);
    if (new Set(activeOrders).size !== activeOrders.length) {
      return { kind: "blocked_root", reason: "linear_sibling_order_ambiguous" };
    }
    siblings.sort((left, right) => left.siblingOrder - right.siblingOrder);
  }

  const visit = (parentId: string | null): RootAction | undefined => {
    for (const node of childrenByParent.get(parentId) ?? []) {
      if (node.state === "Canceled") continue;
      const children = childrenByParent.get(node.issueId) ?? [];
      if (node.kind === "human" && children.length > 0) {
        return { kind: "blocked_root", reason: "human_node_not_leaf" };
      }
      if (children.length > 0) {
        const descendant = visit(node.issueId);
        if (descendant) return descendant;
        continue;
      }
      if (node.kind === "human") {
        if (
          node.state === "Done" &&
          node.humanKind !== "plan_approval" &&
          !node.answer
        ) {
          return { kind: "blocked_root", reason: "human_answer_missing" };
        }
        if (node.state !== "Done") {
          return { kind: "wait_human", nodeId: node.issueId };
        }
        continue;
      }
      if (node.state === "In Review" || node.state === "Done") {
        if (!node.completedInputHash) {
          return { kind: "blocked_root", reason: "completed_work_metadata_missing" };
        }
        if (
          node.currentInputHash &&
          node.currentInputHash !== node.completedInputHash
        ) {
          return { kind: "execute_work", nodeId: node.issueId };
        }
        continue;
      }
      return { kind: "execute_work", nodeId: node.issueId };
    }
    return undefined;
  };
  return visit(null) ?? { kind: "run_root_gate" };
}

function hasChildren(issueId: string, nodes: WorkflowNode[]) {
  return nodes.some(
    (node) => node.parentIssueId === issueId && node.state !== "Canceled",
  );
}
