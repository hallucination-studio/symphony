import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import {
  convergenceRecordId,
  parseManagedRecord,
  rootConvergencePolicyId,
  serializeManagedRecord,
} from "../api/index.js";
import type {
  ConvergenceRecord,
  FindingDispositionRecord,
  ManagedRecord,
  RootConvergencePolicy,
  RootConvergenceView,
  StageExecutionRecord,
  StageResultRecord,
} from "../api/ManagedRecords.js";
import type {
  RootConvergenceAssessment,
  RootConvergenceLinearGateway,
  RootConvergencePolicyInterface,
} from "../api/RootConvergencePolicyInterface.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import { deriveRootUsageAggregate } from "./UsageAggregation.js";

type ManagedComment = {
  comment: LinearWorkflowTreeSnapshot["comments"][number];
  record: ManagedRecord;
};

export class LinearRootConvergencePolicyImpl implements RootConvergencePolicyInterface {
  constructor(private readonly linear: RootConvergenceLinearGateway) {}

  assess(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
    git: Parameters<RootConvergencePolicyInterface["assess"]>[0]["git"];
  }): RootConvergenceAssessment {
    const rootIssue = input.tree.issues.find(({ issue_id }) => issue_id === input.root.issueId);
    if (!rootIssue || rootIssue.issue_kind !== "root" || rootIssue.parent_issue_id !== undefined) {
      throw new Error("root_convergence_root_invalid");
    }
    const comments = managedComments(input.tree);
    const policy = readPolicy(comments, input.root.issueId);
    const view = convergenceView({ rootIssueId: input.root.issueId, tree: input.tree, comments, policy });
    const trigger = convergenceTrigger(policy, view);
    if (trigger === "none") return { snapshot: { policy, view }, trigger };

    const record: ConvergenceRecord = {
      kind: "convergence",
      version: 1,
      convergenceRecordId: convergenceRecordId({
        rootIssueId: input.root.issueId,
        policyId: policy.policyId,
        view,
        trigger,
      }),
      rootIssueId: input.root.issueId,
      policyId: policy.policyId,
      policy: policyValues(policy),
      view,
      trigger,
    };
    const existing = matchingAssessment(comments, record);
    return {
      snapshot: {
        policy,
        view,
        ...(existing ? { assessment: recordReference(existing) } : {}),
      },
      trigger,
      record,
    };
  }

  async persistNonAllowing(input: {
    root: DiscoveredRoot;
    tree: LinearWorkflowTreeSnapshot;
    assessment: RootConvergenceAssessment;
  }): Promise<LinearWorkflowTreeSnapshot> {
    const record = input.assessment.record;
    if (!record || input.assessment.trigger === "none") {
      throw new Error("root_convergence_persist_allowing_invalid");
    }
    if (input.assessment.snapshot.assessment) return input.tree;
    const rootIssue = input.tree.issues.find(({ issue_id }) => issue_id === input.root.issueId);
    if (!rootIssue) throw new Error("root_convergence_root_missing");
    const outcome = await this.linear.mutateWorkflow({
      kind: "append_workflow_comment",
      writeId: record.convergenceRecordId,
      expectedProjectId: input.root.projectId,
      rootIssueId: input.root.issueId,
      expectedRootRemoteVersion: rootIssue.remote_version,
      target: {
        targetIssueId: rootIssue.issue_id,
        expectedRemoteVersion: rootIssue.remote_version,
        expectedStatusId: rootIssue.status_id,
      },
      body: serializeManagedRecord(record),
    });
    if (outcome.kind === "failed" || outcome.kind === "precondition_conflict") {
      throw new Error("root_convergence_record_write_failed");
    }
    const readBack = await this.linear.readWorkflowIssueTree(input.root.issueId);
    const persisted = this.assess({ root: input.root, tree: readBack, git: {
      head: "unavailable", branch: "unavailable", status: { items: [], returned: 0, cap: 0, has_more: false, partial: false },
    } });
    if (persisted.record?.convergenceRecordId !== record.convergenceRecordId || !persisted.snapshot.assessment) {
      throw new Error("root_convergence_record_read_back_failed");
    }
    return readBack;
  }
}

function managedComments(tree: LinearWorkflowTreeSnapshot): ManagedComment[] {
  return tree.comments.flatMap((comment) => {
    if (comment.author_kind !== "symphony") return [];
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) throw new Error(`root_convergence_record_invalid:${parsed.error}`);
    return [{ comment, record: parsed.value }];
  });
}

function readPolicy(comments: ManagedComment[], rootIssueId: string): RootConvergencePolicy {
  const policies = comments.flatMap(({ comment, record }) => {
    if (record.kind !== "root_convergence_policy") return [];
    if (comment.issue_id !== rootIssueId || record.rootIssueId !== rootIssueId) {
      throw new Error("root_convergence_policy_scope_invalid");
    }
    if (record.policyId !== rootConvergencePolicyId(rootIssueId)) {
      throw new Error("root_convergence_policy_identity_invalid");
    }
    validatePolicy(record);
    return [record];
  });
  if (policies.length === 0) throw new Error("root_convergence_policy_missing");
  if (policies.length !== 1) throw new Error("root_convergence_policy_duplicate");
  return policies[0]!;
}

function convergenceView(input: {
  rootIssueId: string;
  tree: LinearWorkflowTreeSnapshot;
  comments: ManagedComment[];
  policy: RootConvergencePolicy;
}): RootConvergenceView {
  const cycles = input.tree.issues.filter((issue) =>
    issue.issue_kind === "cycle" && issue.parent_issue_id === input.rootIssueId,
  );
  const activeCycles = cycles.filter((cycle) => !cycle.is_archived && !terminal(cycle));
  const activeCycleIssueId = activeCycles.length === 1 ? activeCycles[0]!.issue_id : undefined;
  const stageResults = stageResultsFor(input.comments, input.rootIssueId);
  const executions = stageExecutionsFor(input.comments, input.rootIssueId);
  const usage = deriveRootUsageAggregate({ tree: input.tree, rootIssueId: input.rootIssueId });
  const settledTokens = usage.groups.reduce((total, group) => total + group.totalTokens, 0);
  const completedExecutionIds = new Set(stageResults.map(({ modelTurn }) => modelTurn.stageExecutionId));
  const openTokenReservations = executions
    .filter(({ stageExecutionId }) => !completedExecutionIds.has(stageExecutionId))
    .map(({ stageExecutionId, limits }) => ({ stageExecutionId, reservedTotalTokens: limits.reservedTotalTokens }))
    .sort((left, right) => left.stageExecutionId.localeCompare(right.stageExecutionId));
  const activeCycleRepairAttempts = activeCycleIssueId === undefined
    ? 0
    : stageResults.filter((result) => result.cycleIssueId === activeCycleIssueId && repairRequired(result.outcomeKind)).length;
  const rootIssue = input.tree.issues.find(({ issue_id }) => issue_id === input.rootIssueId);
  if (!rootIssue) throw new Error("root_convergence_root_missing");
  return {
    cycleCount: cycles.length,
    openFindingPersistence: openFindingPersistence(input.comments, stageResults, input.rootIssueId),
    consecutiveNoProgress: consecutiveNoProgress(input.comments, input.rootIssueId),
    settledTokens,
    openTokenReservations,
    ...(activeCycleIssueId === undefined ? {} : { activeCycleIssueId }),
    activeCycleRepairAttempts,
    isDeadlineExceeded: Date.parse(input.tree.observed_at) >= Date.parse(input.policy.deadlineAt),
    rootIsCanceled: rootIssue.status_category === "canceled",
  };
}

function stageResultsFor(comments: ManagedComment[], rootIssueId: string): StageResultRecord[] {
  const results = comments.flatMap(({ comment, record }) => {
    if (record.kind !== "stage_result") return [];
    if (record.rootIssueId !== rootIssueId || comment.issue_id !== record.nodeIssueId) {
      throw new Error("root_convergence_stage_result_scope_invalid");
    }
    return [record];
  });
  const ids = new Set<string>();
  for (const result of results) {
    if (ids.has(result.modelTurn.stageExecutionId)) throw new Error("root_convergence_stage_result_duplicate");
    ids.add(result.modelTurn.stageExecutionId);
  }
  return results;
}

function stageExecutionsFor(comments: ManagedComment[], rootIssueId: string): StageExecutionRecord[] {
  return comments.flatMap(({ comment, record }) => {
    if (record.kind !== "stage_execution") return [];
    if (record.rootIssueId !== rootIssueId || comment.issue_id !== record.nodeIssueId) {
      throw new Error("root_convergence_stage_execution_scope_invalid");
    }
    return [record];
  });
}

function openFindingPersistence(
  comments: ManagedComment[],
  stageResults: StageResultRecord[],
  rootIssueId: string,
): Array<{ findingId: string; openCycleCount: number }> {
  const cyclesByVerify = new Map(stageResults
    .filter(({ stage }) => stage === "verify")
    .map((result) => [result.modelTurn.stageExecutionId, result.cycleIssueId]));
  const findings = comments.flatMap(({ record }) => record.kind === "finding" ? [record] : []);
  const dispositions = comments.flatMap(({ record }) => record.kind === "finding_disposition" ? [record] : []);
  const closedFindingIds = closedFindings(dispositions, cyclesByVerify);
  const cyclesByFinding = new Map<string, Set<string>>();
  for (const finding of findings) {
    const cycleIssueId = cyclesByVerify.get(finding.sourceVerifyId);
    if (!cycleIssueId) throw new Error("root_convergence_finding_source_invalid");
    if (closedFindingIds.has(finding.findingId)) continue;
    const cycles = cyclesByFinding.get(finding.findingId) ?? new Set<string>();
    cycles.add(cycleIssueId);
    cyclesByFinding.set(finding.findingId, cycles);
  }
  for (const { record } of comments) {
    if (record.kind !== "cycle_outcome" || record.rootIssueId !== rootIssueId) continue;
    for (const findingId of record.unresolvedFindingIds) {
      if (closedFindingIds.has(findingId)) continue;
      const cycles = cyclesByFinding.get(findingId) ?? new Set<string>();
      cycles.add(record.cycleIssueId);
      cyclesByFinding.set(findingId, cycles);
    }
  }
  return [...cyclesByFinding.entries()]
    .map(([findingId, cycles]) => ({ findingId, openCycleCount: cycles.size }))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
}

function closedFindings(
  dispositions: FindingDispositionRecord[],
  cyclesByVerify: Map<string, string>,
): Set<string> {
  const dispositionsBySource = new Map<string, FindingDispositionRecord>();
  for (const disposition of dispositions) {
    if (!cyclesByVerify.has(disposition.sourceVerifyId)) {
      throw new Error("root_convergence_finding_disposition_source_invalid");
    }
    const key = `${disposition.findingId}\u0000${disposition.sourceVerifyId}`;
    if (dispositionsBySource.has(key)) throw new Error("root_convergence_finding_disposition_duplicate");
    dispositionsBySource.set(key, disposition);
  }
  return new Set([...dispositionsBySource.values()]
    .filter(({ disposition }) => disposition === "resolved" || disposition === "waived")
    .map(({ findingId }) => findingId));
}

function consecutiveNoProgress(comments: ManagedComment[], rootIssueId: string): number {
  const assessments = comments
    .flatMap(({ comment, record }) => record.kind === "progress_assessment" ? [{ comment, record }] : [])
    .filter(({ record }) => {
      if (record.rootIssueId !== rootIssueId) throw new Error("root_convergence_progress_scope_invalid");
      return true;
    })
    .sort((left, right) => left.comment.updated_at.localeCompare(right.comment.updated_at) || left.comment.comment_id.localeCompare(right.comment.comment_id));
  let count = 0;
  for (const { record } of assessments.reverse()) {
    if (record.isProgress) break;
    count += 1;
  }
  return count;
}

function convergenceTrigger(policy: RootConvergencePolicy, view: RootConvergenceView) {
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
  if (view.settledTokens + view.openTokenReservations.reduce((total, entry) => total + entry.reservedTotalTokens, 0) >= policy.maxTotalTokens) {
    return "token_budget" as const;
  }
  if (view.activeCycleIssueId && view.activeCycleRepairAttempts > policy.maxCycleRepairAttempts) {
    return "max_cycle_repair_attempts" as const;
  }
  return "none" as const;
}

function matchingAssessment(comments: ManagedComment[], expected: ConvergenceRecord): ConvergenceRecord | undefined {
  const records = comments.flatMap(({ comment, record }) => {
    if (record.kind !== "convergence") return [];
    if (comment.issue_id !== expected.rootIssueId || record.rootIssueId !== expected.rootIssueId || record.policyId !== expected.policyId) {
      throw new Error("root_convergence_assessment_scope_invalid");
    }
    const identity = convergenceRecordId({
      rootIssueId: record.rootIssueId,
      policyId: record.policyId,
      view: record.view,
      trigger: record.trigger,
    });
    if (record.convergenceRecordId !== identity) throw new Error("root_convergence_assessment_identity_invalid");
    return [record];
  });
  const matching = records.filter(({ convergenceRecordId }) => convergenceRecordId === expected.convergenceRecordId);
  if (matching.length > 1) throw new Error("root_convergence_assessment_duplicate");
  if (matching[0] && serializeManagedRecord(matching[0]) !== serializeManagedRecord(expected)) {
    throw new Error("root_convergence_assessment_mismatch");
  }
  return matching[0];
}

function validatePolicy(policy: RootConvergencePolicy): void {
  for (const value of [
    policy.maxCyclesPerRoot,
    policy.maxSameOpenFindingCycles,
    policy.maxConsecutiveNoProgress,
    policy.maxTotalTokens,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("root_convergence_policy_value_invalid");
  }
  if (!Number.isSafeInteger(policy.maxCycleRepairAttempts) || policy.maxCycleRepairAttempts < 0 || !Number.isFinite(Date.parse(policy.deadlineAt))) {
    throw new Error("root_convergence_policy_value_invalid");
  }
}

function policyValues(policy: RootConvergencePolicy) {
  return {
    maxCyclesPerRoot: policy.maxCyclesPerRoot,
    maxSameOpenFindingCycles: policy.maxSameOpenFindingCycles,
    maxConsecutiveNoProgress: policy.maxConsecutiveNoProgress,
    maxTotalTokens: policy.maxTotalTokens,
    maxCycleRepairAttempts: policy.maxCycleRepairAttempts,
    deadlineAt: policy.deadlineAt,
  };
}

function recordReference(record: ConvergenceRecord) {
  return {
    recordId: record.convergenceRecordId,
    recordKind: "convergence" as const,
    recordVersion: "1" as const,
    writeId: record.convergenceRecordId,
  };
}

function terminal(issue: LinearWorkflowTreeSnapshot["issues"][number]): boolean {
  return issue.status_category === "completed" || issue.status_category === "canceled" ||
    ["Succeeded", "Changes Required", "Canceled"].includes(issue.status_name);
}

function repairRequired(outcome: StageResultRecord["outcomeKind"]): boolean {
  return [
    "work_plan_assumption_invalid",
    "work_scope_conflict",
    "verify_changes_required",
    "verify_inconclusive",
    "verify_plan_contract_violation",
    "execution_failed",
  ].includes(outcome);
}
