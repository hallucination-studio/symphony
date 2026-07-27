import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootConvergencePolicySnapshot,
  RootConvergencePolicyValues,
  RootConvergenceView,
} from "../api/RootConvergence.js";
import type {
  RootConvergenceAssessment,
  RootConvergencePolicyInterface,
} from "../api/RootConvergencePolicyInterface.js";
import type { DiscoveredRoot } from "../api/RootModels.js";

type WorkflowIssue = LinearWorkflowTreeSnapshot["issues"][number];

const PRIMARY_KINDS = ["Root", "Cycle", "Plan", "Work", "Verify", "Finding"] as const;

export class LinearRootConvergencePolicyImpl implements RootConvergencePolicyInterface {
  constructor(
    private readonly configured: RootConvergencePolicyValues,
    private readonly deadlineDurationMs: number,
  ) {
    validateConfiguration(configured, deadlineDurationMs);
  }

  assess(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
  }): RootConvergenceAssessment {
    const rootIssue = input.tree.issues.find(({ issue_id }) => issue_id === input.root.issueId);
    if (!rootIssue || rootIssue.parent_issue_id !== undefined || issueKind(rootIssue) !== "Root") {
      throw new Error("root_convergence_root_invalid");
    }
    const policy = policySnapshot(this.configured, rootIssue.created_at, this.deadlineDurationMs);
    const view = convergenceView(input.tree, rootIssue, policy);
    return { snapshot: { policy, view }, trigger: convergenceTrigger(policy, view) };
  }
}

function policySnapshot(
  configured: RootConvergencePolicyValues,
  rootCreatedAt: string,
  deadlineDurationMs: number,
): RootConvergencePolicySnapshot {
  const createdAt = Date.parse(rootCreatedAt);
  if (!Number.isFinite(createdAt) || createdAt > 8_640_000_000_000_000 - deadlineDurationMs) {
    throw new Error("root_convergence_created_at_invalid");
  }
  return {
    ...configured,
    deadlineAt: new Date(createdAt + deadlineDurationMs).toISOString(),
  };
}

function convergenceView(
  tree: LinearWorkflowTreeSnapshot,
  rootIssue: WorkflowIssue,
  policy: RootConvergencePolicySnapshot,
): RootConvergenceView {
  const cycles = tree.issues.filter((issue) =>
    issue.parent_issue_id === rootIssue.issue_id && issueKind(issue) === "Cycle",
  );
  const activeCycles = cycles.filter((cycle) => !cycle.is_archived && !terminal(cycle));
  if (activeCycles.length > 1) throw new Error("root_convergence_active_cycle_ambiguous");
  const activeCycleIssueId = activeCycles[0]?.issue_id;
  return {
    cycleCount: cycles.length,
    openFindingPersistence: openFindingPersistence(tree, cycles),
    consecutiveNoProgress: consecutiveNoProgress(tree, cycles),
    ...(activeCycleIssueId ? { activeCycleIssueId } : {}),
    activeCycleRepairAttempts: activeCycleIssueId
      ? activeRepairAttempts(tree, activeCycleIssueId)
      : 0,
    isDeadlineExceeded: timestamp(tree.observed_at, "root_convergence_observed_at_invalid") >=
      timestamp(policy.deadlineAt, "root_convergence_deadline_invalid"),
    rootIsCanceled: rootIssue.status_category === "canceled" || rootIssue.status_name === "Canceled",
  };
}

function activeRepairAttempts(tree: LinearWorkflowTreeSnapshot, cycleIssueId: string): number {
  return tree.issues.filter((issue) => {
    if (issue.parent_issue_id !== cycleIssueId) return false;
    const kind = issueKind(issue);
    if (kind !== "Work" && kind !== "Verify") return false;
    if (issue.status_name === "Failed" || issue.status_name === "Interrupted") return true;
    return kind === "Verify" && issue.status_name === "Done" && issue.labels.some((label) =>
      label === "Changes Required" || label === "Inconclusive" || label === "Contract Violation",
    );
  }).length;
}

function openFindingPersistence(
  tree: LinearWorkflowTreeSnapshot,
  cycles: WorkflowIssue[],
): Array<{ findingId: string; openCycleCount: number }> {
  const cycleIds = new Set(cycles.map(({ issue_id }) => issue_id));
  const findings = tree.issues.filter((issue) =>
    issue.parent_issue_id !== undefined && cycleIds.has(issue.parent_issue_id) && issueKind(issue) === "Finding",
  );
  const findingsById = new Map(findings.map((finding) => [finding.issue_id, finding]));
  const adjacent = new Map<string, Set<string>>();
  for (const relation of tree.relations) {
    if (relation.relation_kind !== "triggered_by" ||
        !findingsById.has(relation.source_issue_id) || !findingsById.has(relation.target_issue_id)) continue;
    connect(adjacent, relation.source_issue_id, relation.target_issue_id);
    connect(adjacent, relation.target_issue_id, relation.source_issue_id);
  }
  const result: Array<{ findingId: string; openCycleCount: number }> = [];
  const visited = new Set<string>();
  for (const finding of findings) {
    if (visited.has(finding.issue_id)) continue;
    const component = collectComponent(finding.issue_id, adjacent);
    component.forEach((id) => visited.add(id));
    const open = [...component]
      .map((id) => findingsById.get(id)!)
      .filter((candidate) => !candidate.is_archived && !terminal(candidate));
    if (open.length > 1) throw new Error("root_convergence_finding_lineage_ambiguous");
    if (open.length === 0) continue;
    const openCycleCount = new Set([...component].map((id) => findingsById.get(id)!.parent_issue_id)).size;
    result.push({ findingId: open[0]!.issue_id, openCycleCount });
  }
  return result.sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function consecutiveNoProgress(tree: LinearWorkflowTreeSnapshot, cycles: WorkflowIssue[]): number {
  const terminalCycles = cycles
    .filter(terminal)
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.issue_id.localeCompare(left.issue_id));
  let count = 0;
  for (const cycle of terminalCycles) {
    if (cycle.status_name !== "Changes Required" || cycleHasProgress(tree, cycle.issue_id)) break;
    count += 1;
  }
  return count;
}

function cycleHasProgress(tree: LinearWorkflowTreeSnapshot, cycleIssueId: string): boolean {
  return tree.issues.some((issue) => {
    if (issue.parent_issue_id !== cycleIssueId) return false;
    const kind = issueKind(issue);
    return (kind === "Work" && issue.status_name === "Done") ||
      (kind === "Verify" && issue.status_name === "Done" && issue.labels.includes("Passed"));
  });
}

function convergenceTrigger(policy: RootConvergencePolicySnapshot, view: RootConvergenceView) {
  if (view.rootIsCanceled) return "root_canceled" as const;
  if (view.isDeadlineExceeded) return "deadline_exceeded" as const;
  if (view.cycleCount > policy.maxCyclesPerRoot ||
      (view.cycleCount === policy.maxCyclesPerRoot && !view.activeCycleIssueId)) {
    return "max_cycles_per_root" as const;
  }
  if (view.openFindingPersistence.some(({ openCycleCount }) => openCycleCount >= policy.maxSameOpenFindingCycles)) {
    return "max_same_open_finding_cycles" as const;
  }
  if (view.consecutiveNoProgress >= policy.maxConsecutiveNoProgress) return "max_consecutive_no_progress" as const;
  if (view.activeCycleIssueId && view.activeCycleRepairAttempts > policy.maxCycleRepairAttempts) {
    return "max_cycle_repair_attempts" as const;
  }
  return "none" as const;
}

function issueKind(issue: WorkflowIssue): typeof PRIMARY_KINDS[number] | undefined {
  const matching = PRIMARY_KINDS.filter((kind) => issue.labels.includes(kind));
  if (matching.length > 1) throw new Error("root_convergence_issue_kind_ambiguous");
  return matching[0];
}

function terminal(issue: WorkflowIssue): boolean {
  return issue.status_category === "completed" || issue.status_category === "canceled" ||
    ["Interrupted", "Failed", "Canceled"].includes(issue.status_name);
}

function connect(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const values = adjacency.get(from) ?? new Set<string>();
  values.add(to);
  adjacency.set(from, values);
}

function collectComponent(start: string, adjacency: Map<string, Set<string>>): Set<string> {
  const result = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return result;
}

function validateConfiguration(configured: RootConvergencePolicyValues, deadlineDurationMs: number): void {
  for (const value of [configured.maxCyclesPerRoot, configured.maxSameOpenFindingCycles, configured.maxConsecutiveNoProgress]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("root_convergence_policy_value_invalid");
  }
  if (!Number.isSafeInteger(configured.maxCycleRepairAttempts) || configured.maxCycleRepairAttempts < 0 ||
      !Number.isSafeInteger(deadlineDurationMs) || deadlineDurationMs < 1) {
    throw new Error("root_convergence_policy_value_invalid");
  }
}

function timestamp(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}
