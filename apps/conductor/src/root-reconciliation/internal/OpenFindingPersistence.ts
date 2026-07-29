import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowIssueKinds } from "../../linear-gateway/api/WorkflowKindLabels.js";

type WorkflowIssue = LinearWorkflowTreeSnapshot["issues"][number];

export interface OpenFindingLineage {
  findingId: string;
  openCycleCount: number;
  findingIds: string[];
}

export function deriveOpenFindingPersistence(
  tree: LinearWorkflowTreeSnapshot,
  rootIssueId: string,
  activeCycleIssueId: string | undefined,
): OpenFindingLineage[] {
  const cycles = tree.issues
    .filter((issue) => issue.parent_issue_id === rootIssueId && issueKind(issue) === "cycle")
    .sort(compareCreatedAt);
  const cycleIndexes = new Map(cycles.map((cycle, index) => [cycle.issue_id, index]));
  const findings = tree.issues.filter((issue) =>
    issue.parent_issue_id !== undefined && cycleIndexes.has(issue.parent_issue_id) && issueKind(issue) === "finding");
  const findingsById = new Map(findings.map((finding) => [finding.issue_id, finding]));
  const predecessorBySuccessor = new Map<string, string>();
  const successorByPredecessor = new Map<string, string>();
  const findingRelations = tree.relations.filter((relation) =>
    relation.relation_kind === "triggered_by" &&
    findingsById.has(relation.source_issue_id) && findingsById.has(relation.target_issue_id));
  if (findingRelations.length > 0) {
    for (let index = 1; index < cycles.length; index += 1) {
      if (cycles[index - 1]!.created_at === cycles[index]!.created_at) invalid();
    }
  }

  for (const relation of findingRelations) {
    const successor = findingsById.get(relation.source_issue_id)!;
    const predecessor = findingsById.get(relation.target_issue_id)!;
    const successorCycleIndex = cycleIndexes.get(successor.parent_issue_id!);
    const predecessorCycleIndex = cycleIndexes.get(predecessor.parent_issue_id!);
    if (successor.issue_id === predecessor.issue_id || successorCycleIndex === undefined ||
        predecessorCycleIndex === undefined || successorCycleIndex !== predecessorCycleIndex + 1 ||
        predecessorBySuccessor.has(successor.issue_id) || successorByPredecessor.has(predecessor.issue_id)) invalid();
    predecessorBySuccessor.set(successor.issue_id, predecessor.issue_id);
    successorByPredecessor.set(predecessor.issue_id, successor.issue_id);
  }

  const open = findings.filter((finding) => !finding.is_archived && !terminal(finding));
  const tipCycleIssueId = activeCycleIssueId ?? cycles.at(-1)?.issue_id;
  if (open.some((finding) => finding.parent_issue_id !== tipCycleIssueId)) invalid();
  const result = open.map((finding) => {
    if (successorByPredecessor.has(finding.issue_id)) invalid();
    const findingIds = [finding.issue_id];
    const visited = new Set(findingIds);
    let current = finding.issue_id;
    while (predecessorBySuccessor.has(current)) {
      const predecessorId = predecessorBySuccessor.get(current)!;
      const predecessor = findingsById.get(predecessorId)!;
      if (terminal(predecessor)) break;
      if (!predecessor.is_archived || visited.has(predecessorId)) invalid();
      current = predecessorId;
      visited.add(current);
      findingIds.push(current);
    }
    return { findingId: finding.issue_id, openCycleCount: findingIds.length, findingIds };
  });
  return result.sort((left, right) => compareCodePoints(left.findingId, right.findingId));
}

function compareCreatedAt(left: WorkflowIssue, right: WorkflowIssue): number {
  const leftTimestamp = Date.parse(left.created_at);
  const rightTimestamp = Date.parse(right.created_at);
  if (!Number.isFinite(leftTimestamp) || !Number.isFinite(rightTimestamp)) invalid();
  return leftTimestamp - rightTimestamp;
}

function issueKind(issue: WorkflowIssue) {
  const matching = workflowIssueKinds(issue.labels);
  if (matching.length > 1) invalid();
  return matching[0];
}

function terminal(issue: WorkflowIssue): boolean {
  return issue.status_category === "completed" || issue.status_category === "canceled" ||
    ["Interrupted", "Failed", "Canceled"].includes(issue.status_name);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(): never {
  throw new Error("root_convergence_finding_lineage_invalid");
}
