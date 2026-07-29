import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { workflowIssueKinds } from "../../linear-gateway/api/WorkflowKindLabels.js";
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
import { deriveOpenFindingPersistence } from "./OpenFindingPersistence.js";

type WorkflowIssue = LinearWorkflowTreeSnapshot["issues"][number];

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
    if (!rootIssue || rootIssue.parent_issue_id !== undefined || issueKind(rootIssue) !== "root") {
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
    issue.parent_issue_id === rootIssue.issue_id && issueKind(issue) === "cycle",
  );
  const activeCycles = cycles.filter((cycle) => !cycle.is_archived && !terminal(cycle));
  if (activeCycles.length > 1) throw new Error("root_convergence_active_cycle_ambiguous");
  const activeCycleIssueId = activeCycles[0]?.issue_id;
  return {
    cycleCount: cycles.length,
    openFindingPersistence: deriveOpenFindingPersistence(tree, rootIssue.issue_id, activeCycleIssueId)
      .map(({ findingId, openCycleCount }) => ({ findingId, openCycleCount })),
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
    if (kind !== "work" && kind !== "verify") return false;
    if (issue.status_name === "Failed" || issue.status_name === "Interrupted") return true;
    return kind === "verify" && issue.status_name === "Done" && issue.labels.some((label) =>
      label === "Changes Required" || label === "Inconclusive" || label === "Contract Violation",
    );
  }).length;
}

function convergenceTrigger(policy: RootConvergencePolicySnapshot, view: RootConvergenceView) {
  if (view.rootIsCanceled) return "root_canceled" as const;
  if (view.isDeadlineExceeded) return "deadline_exceeded" as const;
  if (view.cycleCount > policy.maxCyclesPerRoot ||
      (view.cycleCount === policy.maxCyclesPerRoot && !view.activeCycleIssueId)) {
    return "max_cycles_per_root" as const;
  }
  if (view.activeCycleIssueId &&
      view.openFindingPersistence.some(({ openCycleCount }) => openCycleCount >= policy.maxSameOpenFindingCycles)) {
    return "max_same_open_finding_cycles" as const;
  }
  if (view.activeCycleIssueId && view.activeCycleRepairAttempts > policy.maxCycleRepairAttempts) {
    return "max_cycle_repair_attempts" as const;
  }
  return "none" as const;
}

function issueKind(issue: WorkflowIssue) {
  const matching = workflowIssueKinds(issue.labels);
  if (matching.length > 1) throw new Error("root_convergence_issue_kind_ambiguous");
  return matching[0];
}

function terminal(issue: WorkflowIssue): boolean {
  return issue.status_category === "completed" || issue.status_category === "canceled" ||
    ["Interrupted", "Failed", "Canceled"].includes(issue.status_name);
}

function validateConfiguration(configured: RootConvergencePolicyValues, deadlineDurationMs: number): void {
  for (const value of [configured.maxCyclesPerRoot, configured.maxSameOpenFindingCycles]) {
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
