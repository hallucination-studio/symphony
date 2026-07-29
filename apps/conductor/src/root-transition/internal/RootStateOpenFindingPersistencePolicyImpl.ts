import type {
  RootStateOpenFindingLineage,
  RootStateOpenFindingPersistencePolicyInterface,
} from "../api/RootStateOpenFindingPersistencePolicyInterface.js";
import type { RootStateIssue } from "../api/RootStateViewPolicyInterface.js";

export class RootStateOpenFindingPersistencePolicyImpl implements RootStateOpenFindingPersistencePolicyInterface {
  derive(input: Parameters<RootStateOpenFindingPersistencePolicyInterface["derive"]>[0]): readonly RootStateOpenFindingLineage[] {
    const cycles = input.view.issues
      .filter(({ parentIssueId, issueKind }) => parentIssueId === input.view.rootIssueId && issueKind === "cycle")
      .sort(compareCreatedAt);
    const cycleIndexes = new Map(cycles.map((cycle, index) => [cycle.issueId, index]));
    const findings = input.view.issues.filter(({ parentIssueId, issueKind }) =>
      parentIssueId !== undefined && cycleIndexes.has(parentIssueId) && issueKind === "finding");
    const findingsById = new Map(findings.map((finding) => [finding.issueId, finding]));
    const predecessorBySuccessor = new Map<string, string>();
    const successorByPredecessor = new Map<string, string>();
    const relations = input.view.relations.filter(({ relationKind, sourceIssueId, targetIssueId }) =>
      relationKind === "triggered_by" && findingsById.has(sourceIssueId) && findingsById.has(targetIssueId));

    if (relations.length > 0) {
      for (let index = 1; index < cycles.length; index += 1) {
        if (cycles[index - 1]!.createdAt === cycles[index]!.createdAt) invalid();
      }
    }
    for (const relation of relations) {
      const successor = findingsById.get(relation.sourceIssueId)!;
      const predecessor = findingsById.get(relation.targetIssueId)!;
      const successorIndex = cycleIndexes.get(successor.parentIssueId!);
      const predecessorIndex = cycleIndexes.get(predecessor.parentIssueId!);
      if (successor.issueId === predecessor.issueId || successorIndex === undefined || predecessorIndex === undefined ||
          successorIndex !== predecessorIndex + 1 || predecessorBySuccessor.has(successor.issueId) ||
          successorByPredecessor.has(predecessor.issueId)) invalid();
      predecessorBySuccessor.set(successor.issueId, predecessor.issueId);
      successorByPredecessor.set(predecessor.issueId, successor.issueId);
    }

    const activeNonterminal = findings.filter((finding) => !finding.isArchived && !terminal(finding));
    if (activeNonterminal.some((finding) => !openStatus(finding))) invalid();
    const open = activeNonterminal.filter(openStatus);
    const tipCycleIssueId = input.activeCycleIssueId ?? cycles.at(-1)?.issueId;
    if (open.some(({ parentIssueId }) => parentIssueId !== tipCycleIssueId)) invalid();
    const result = open.map((finding) => {
      if (successorByPredecessor.has(finding.issueId)) invalid();
      const findingIds = [finding.issueId];
      const visited = new Set(findingIds);
      let current = finding.issueId;
      while (predecessorBySuccessor.has(current)) {
        const predecessorId = predecessorBySuccessor.get(current)!;
        const predecessor = findingsById.get(predecessorId)!;
        if (terminal(predecessor)) break;
        if (!predecessor.isArchived || !openStatus(predecessor) || visited.has(predecessorId)) invalid();
        current = predecessorId;
        visited.add(current);
        findingIds.push(current);
      }
      return Object.freeze({ findingId: finding.issueId, openCycleCount: findingIds.length, findingIds: Object.freeze(findingIds) });
    });
    return Object.freeze(result.sort((left, right) => compareCodePoints(left.findingId, right.findingId)));
  }
}

function compareCreatedAt(left: RootStateIssue, right: RootStateIssue): number {
  const leftTimestamp = Date.parse(left.createdAt);
  const rightTimestamp = Date.parse(right.createdAt);
  if (!Number.isFinite(leftTimestamp) || !Number.isFinite(rightTimestamp)) invalid();
  return leftTimestamp - rightTimestamp;
}

function terminal(issue: RootStateIssue): boolean {
  return issue.statusCategory === "completed" || issue.statusCategory === "canceled" ||
    issue.statusName === "Interrupted" || issue.statusName === "Failed" || issue.statusName === "Canceled";
}

function openStatus(issue: RootStateIssue): boolean {
  return issue.statusName === "Todo" || issue.statusName === "In Progress";
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(): never {
  throw new Error("root_state_finding_lineage_invalid");
}
