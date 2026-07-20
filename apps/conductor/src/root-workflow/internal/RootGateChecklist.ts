import type { WorkflowNode } from "../api/Models.js";

export const ROOT_GATE_TITLE = "[Root Gate] Acceptance Checklist";

const CHECKS = Object.freeze([
  ["root-facts", "Root目标和最新Root facts仍然一致"],
  ["work-evidence", "每个有效Work child都有匹配的completion evidence"],
  ["git-checks", "声明的Git checks通过，且worktree状态符合交付要求"],
  ["blockers", "所有Root blocker都处于Done或Canceled"],
  ["delivery", "当前commit和delivery branch满足Root delivery precondition"],
]);

export function createRootGateDescription(checked: boolean) {
  return [
    "## Root Gate Checklist",
    ...CHECKS.map(([id, text]) => `- [${checked ? "x" : " "}] \`${id}\`: ${text}`),
  ].join("\n");
}

export function validateRootGateNode(
  rootIssueId: string,
  node: WorkflowNode,
  requireChecked: boolean,
) {
  if (node.kind !== "work" ||
      (node.parentIssueId !== rootIssueId && node.parentIssueId !== null) ||
      node.title !== ROOT_GATE_TITLE || node.managedMarker !== `${rootIssueId}:root-gate`) {
    return "root_gate_marker_invalid";
  }
  const expected = createRootGateDescription(requireChecked);
  if (node.description === expected) return undefined;
  if (requireChecked && node.description === createRootGateDescription(false)) {
    return "root_gate_checklist_incomplete";
  }
  return "root_gate_checklist_invalid";
}

export function validateRootGateNodes(
  rootIssueId: string,
  nodes: readonly WorkflowNode[],
  requireChecked: boolean,
) {
  const directNodes = nodes.filter((node) =>
    node.parentIssueId === rootIssueId || node.parentIssueId === null,
  );
  const titled = directNodes.filter(({ title }) => title === ROOT_GATE_TITLE);
  if (titled.length !== 1) return "root_gate_count_invalid";
  const marked = directNodes.filter(({ managedMarker }) =>
    managedMarker === `${rootIssueId}:root-gate`,
  );
  if (marked.length !== 1) return "root_gate_count_invalid";
  return validateRootGateNode(rootIssueId, titled[0]!, requireChecked);
}
