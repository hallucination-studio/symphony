import type { RootDagView } from "../api/RootWorkflowPolicyInterface.js";
import type {
  ConvergenceRecord,
  FindingDispositionRecord,
  FindingRecord,
  ManagedRecord,
  ProgressAssessment,
  StageExecutionRecord,
  StageTerminalRecord,
  VerifyResultRecord,
} from "../api/ManagedRecords.js";

export type RootConvergencePolicy = ConvergenceRecord["policy"];
export type RootConvergenceView = ConvergenceRecord["view"];
export type RootConvergenceTrigger = ConvergenceRecord["trigger"];

export interface RootConvergenceAssessment {
  policy: RootConvergencePolicy;
  view: RootConvergenceView;
  decision: "allow" | "escalate" | "canceled";
  trigger: RootConvergenceTrigger;
}

export interface RootConvergenceInput {
  view: RootDagView;
  now: string;
  policy?: RootConvergencePolicy;
  nextStageReservedTotalTokens?: number;
}

export function toConvergenceRecord(rootIssueId: string, observedAt: string, assessment: RootConvergenceAssessment): ConvergenceRecord {
  return {
    kind: "convergence",
    version: 1,
    rootIssueId,
    observedAt,
    policy: assessment.policy,
    view: assessment.view,
    trigger: assessment.trigger,
    decision: assessment.decision,
  };
}

export const DEFAULT_ROOT_CONVERGENCE_POLICY: RootConvergencePolicy = {
  maxCyclesPerRoot: 3,
  maxSameOpenFindingCycles: 2,
  maxConsecutiveNoProgress: 2,
  maxTotalTokens: Number.MAX_SAFE_INTEGER,
  deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};

export function createDefaultRootConvergencePolicy(now = Date.now()): RootConvergencePolicy {
  if (!Number.isSafeInteger(now)) throw new Error("convergence_policy_clock_invalid");
  return { ...DEFAULT_ROOT_CONVERGENCE_POLICY, deadlineAt: new Date(now + 5 * 60_000).toISOString() };
}

export function assessRootConvergence(input: RootConvergenceInput): RootConvergenceAssessment {
  const policy = input.policy ?? DEFAULT_ROOT_CONVERGENCE_POLICY;
  validatePolicy(policy, input.now, input.nextStageReservedTotalTokens ?? 0);
  const view = buildRootConvergenceView(input.view, policy, input.now);
  const nextReservation = input.nextStageReservedTotalTokens ?? 0;

  if (view.rootIsCanceled) return { policy, view, decision: "canceled", trigger: "root_canceled" };
  if (view.isDeadlineExceeded) return { policy, view, decision: "escalate", trigger: "deadline_exceeded" };
  if (view.cycleCount >= policy.maxCyclesPerRoot) return { policy, view, decision: "escalate", trigger: "max_cycles_per_root" };
  if (view.openFindingPersistence.some((entry) => entry.openCycleCount >= policy.maxSameOpenFindingCycles)) {
    return { policy, view, decision: "escalate", trigger: "max_same_open_finding_cycles" };
  }
  if (view.consecutiveNoProgress >= policy.maxConsecutiveNoProgress) {
    return { policy, view, decision: "escalate", trigger: "max_consecutive_no_progress" };
  }
  if (view.settledTokens + view.openTokenReservations.reduce((total, entry) => total + entry.reservedTotalTokens, 0) + nextReservation > policy.maxTotalTokens) {
    return { policy, view, decision: "escalate", trigger: "token_budget" };
  }
  return { policy, view, decision: "allow", trigger: "none" };
}

export function buildRootConvergenceView(root: RootDagView, policy: RootConvergencePolicy, now: string): RootConvergenceView {
  const cycles = [...root.cycles].sort((left, right) => left.issue.order - right.issue.order || left.issue.issue_id.localeCompare(right.issue.issue_id));
  const executions = new Map<string, { record: StageExecutionRecord; cycleIssueId: string }>();
  const terminals = new Map<string, { record: StageTerminalRecord; cycleIssueId: string }>();
  const findings = new Map<string, { record: FindingRecord; cycleIssueId: string }>();
  const dispositions: Array<{ record: FindingDispositionRecord; cycleIssueId: string }> = [];
  const verifyResults = new Map<string, { record: VerifyResultRecord; cycleIssueId: string }>();
  const progressByCycle = new Map<string, ProgressAssessment>();

  for (const cycle of cycles) {
    for (const record of cycle.records) collectRecord(record, cycle.issue.issue_id);
    for (const node of cycle.nodes) {
      for (const record of node.records) collectRecord(record, cycle.issue.issue_id);
    }
  }

  for (const { record, cycleIssueId } of terminals.values()) {
    const execution = executions.get(record.stageExecutionId);
    if (!execution || execution.cycleIssueId !== cycleIssueId || execution.record.nodeIssueId !== record.nodeIssueId) {
      throw new Error("convergence_terminal_execution_mismatch");
    }
  }
  for (const { record, cycleIssueId } of verifyResults.values()) {
    const execution = executions.get(record.stageExecutionId);
    const terminal = terminals.get(record.stageExecutionId);
    if (!execution || execution.record.stage !== "verify" || !terminal || terminal.record.outcome !== "completed") {
      throw new Error("convergence_verify_execution_missing");
    }
    if (cycleIssueId !== record.cycleIssueId || execution.cycleIssueId !== record.cycleIssueId || execution.record.nodeIssueId !== record.nodeIssueId
      || terminal.cycleIssueId !== record.cycleIssueId || terminal.record.nodeIssueId !== record.nodeIssueId
      || terminal.record.stage !== "verify") {
      throw new Error("convergence_verify_execution_mismatch");
    }
  }
  for (const { record } of findings.values()) {
    if (!verifyResults.has(record.sourceVerifyId)) throw new Error("convergence_finding_verify_missing");
  }
  for (const { record } of dispositions) {
    if (!findings.has(record.findingId)) throw new Error("convergence_disposition_finding_missing");
    if (!verifyResults.has(record.sourceVerifyId)) throw new Error("convergence_disposition_verify_missing");
  }

  const latestDisposition = new Map<string, FindingDispositionRecord>();
  const findingCycleIds = new Map<string, Set<string>>();
  for (const { record, cycleIssueId } of findings.values()) {
    addFindingCycle(findingCycleIds, record.findingId, cycleIssueId);
  }
  const dispositionKeys = new Set<string>();
  for (const { record, cycleIssueId } of dispositions) {
    const key = `${record.findingId}:${record.sourceVerifyId}`;
    if (dispositionKeys.has(key)) throw new Error("convergence_disposition_duplicate");
    dispositionKeys.add(key);
    if (record.disposition === "still_open") addFindingCycle(findingCycleIds, record.findingId, cycleIssueId);
    latestDisposition.set(record.findingId, record);
  }

  const openFindingPersistence = [...findings.keys()]
    .filter((findingId) => {
      const disposition = latestDisposition.get(findingId);
      return disposition === undefined || disposition.disposition === "still_open";
    })
    .map((findingId) => ({ findingId, openCycleCount: findingCycleIds.get(findingId)?.size ?? 0 }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));

  let consecutiveNoProgress = 0;
  for (const cycle of cycles) {
    if (cycle.issue.status_name !== "Changes Required") continue;
    const progress = progressByCycle.get(cycle.issue.issue_id);
    if (!progress) throw new Error("convergence_progress_missing");
    consecutiveNoProgress = progress.isProgress ? 0 : consecutiveNoProgress + 1;
  }

  const settledTokens = [...terminals.values()].reduce((total, { record }) => total + record.usage.totalTokens, 0);
  const openTokenReservations = [...executions.values()]
    .filter(({ record }) => !terminals.has(record.stageExecutionId))
    .sort((left, right) => left.record.startedAt.localeCompare(right.record.startedAt) || left.record.stageExecutionId.localeCompare(right.record.stageExecutionId))
    .map(({ record }) => ({ stageExecutionId: record.stageExecutionId, reservedTotalTokens: record.limits.reservedTotalTokens }));

  return {
    cycleCount: cycles.length,
    openFindingPersistence,
    consecutiveNoProgress,
    settledTokens,
    openTokenReservations,
    isDeadlineExceeded: Date.parse(now) >= Date.parse(policy.deadlineAt),
    rootIsCanceled: root.root.issue.status_name === "Canceled",
  };

  function collectRecord(record: ManagedRecord, cycleIssueId: string): void {
    switch (record.kind) {
      case "stage_execution":
        if (executions.has(record.stageExecutionId)) throw new Error("convergence_execution_duplicate");
        executions.set(record.stageExecutionId, { record, cycleIssueId });
        return;
      case "stage_terminal":
        if (terminals.has(record.stageExecutionId)) throw new Error("convergence_terminal_duplicate");
        terminals.set(record.stageExecutionId, { record, cycleIssueId });
        return;
      case "verify_result":
        if (verifyResults.has(record.stageExecutionId)) throw new Error("convergence_verify_result_duplicate");
        verifyResults.set(record.stageExecutionId, { record, cycleIssueId });
        return;
      case "finding":
        if (findings.has(record.findingId)) throw new Error("convergence_finding_duplicate");
        findings.set(record.findingId, { record, cycleIssueId });
        return;
      case "finding_disposition":
        dispositions.push({ record, cycleIssueId });
        return;
      case "progress_assessment":
        if (progressByCycle.has(cycleIssueId)) throw new Error("convergence_progress_duplicate");
        progressByCycle.set(cycleIssueId, record);
        return;
      default:
        return;
    }
  }
}

function addFindingCycle(cycles: Map<string, Set<string>>, findingId: string, cycleIssueId: string): void {
  const values = cycles.get(findingId) ?? new Set<string>();
  values.add(cycleIssueId);
  cycles.set(findingId, values);
}

function validatePolicy(policy: RootConvergencePolicy, now: string, nextReservation: number): void {
  if (![policy.maxCyclesPerRoot, policy.maxSameOpenFindingCycles, policy.maxConsecutiveNoProgress].every((value) => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(policy.maxTotalTokens) || policy.maxTotalTokens < 0
    || !Number.isSafeInteger(nextReservation) || nextReservation < 0
    || !Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(policy.deadlineAt))) {
    throw new Error("convergence_policy_invalid");
  }
}
