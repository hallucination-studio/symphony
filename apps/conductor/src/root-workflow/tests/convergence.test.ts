import assert from "node:assert/strict";
import test from "node:test";

import type { RootDagView, RootCycleView } from "../api/RootWorkflowPolicyInterface.js";
import type {
  FindingDispositionRecord,
  FindingRecord,
  ManagedRecord,
  ProgressAssessment,
  StageExecutionRecord,
  StageTerminalRecord,
  VerifyResultRecord,
} from "../api/ManagedRecords.js";
import {
  DEFAULT_ROOT_CONVERGENCE_POLICY,
  assessRootConvergence,
} from "../internal/RootConvergencePolicy.js";

test("rebuilds cycle, finding, no-progress, and token facts from the full Root history", () => {
  const view = rootView([
    cycle("cycle-1", 1, "Succeeded", [
      execution("verify-execution-1", "cycle-1", 100),
      terminal("verify-execution-1", "cycle-1", 100),
      verifyResult("verify-execution-1", "cycle-1", "passed"),
      finding("finding-1", "verify-execution-1"),
      progress("cycle-1", "verify-execution-1", true),
    ]),
    cycle("cycle-2", 2, "Changes Required", [
      execution("verify-execution-2", "cycle-2", 200),
      terminal("verify-execution-2", "cycle-2", 200),
      verifyResult("verify-execution-2", "cycle-2", "changes_required"),
      disposition("finding-1", "verify-execution-2", "still_open"),
      progress("cycle-2", "verify-execution-2", false),
      execution("orphaned-execution", "cycle-2", 400),
    ]),
  ]);

  const assessment = assessRootConvergence({
    view,
    now: "2026-07-21T10:00:00Z",
    nextStageReservedTotalTokens: 100,
    policy: { ...DEFAULT_ROOT_CONVERGENCE_POLICY, maxSameOpenFindingCycles: 3, maxTotalTokens: 1_000 },
  });

  assert.equal(assessment.decision, "allow");
  assert.deepEqual(assessment.view, {
    cycleCount: 2,
    openFindingPersistence: [{ findingId: "finding-1", openCycleCount: 2 }],
    consecutiveNoProgress: 1,
    settledTokens: 300,
    openTokenReservations: [{ stageExecutionId: "orphaned-execution", reservedTotalTokens: 400 }],
    isDeadlineExceeded: false,
    rootIsCanceled: false,
  });
});

test("trips the same-open-finding breaker without resetting across successor Cycles", () => {
  const view = rootView([
    cycle("cycle-1", 1, "Changes Required", [
      execution("verify-execution-1", "cycle-1", 1),
      terminal("verify-execution-1", "cycle-1", 1),
      verifyResult("verify-execution-1", "cycle-1", "changes_required"),
      finding("finding-1", "verify-execution-1"),
      progress("cycle-1", "verify-execution-1", true),
    ]),
    cycle("cycle-2", 2, "Changes Required", [
      execution("verify-execution-2", "cycle-2", 1),
      terminal("verify-execution-2", "cycle-2", 1),
      verifyResult("verify-execution-2", "cycle-2", "changes_required"),
      disposition("finding-1", "verify-execution-2", "still_open"),
      progress("cycle-2", "verify-execution-2", true),
    ]),
  ]);

  const assessment = assessRootConvergence({
    view,
    now: "2026-07-21T10:00:00Z",
    policy: { ...DEFAULT_ROOT_CONVERGENCE_POLICY, maxSameOpenFindingCycles: 2 },
  });

  assert.equal(assessment.decision, "escalate");
  assert.equal(assessment.trigger, "max_same_open_finding_cycles");
});

test("trips token, deadline, and cancellation breakers with explicit trigger precedence", () => {
  const view = rootView([cycle("cycle-1", 1, "Succeeded", [])]);
  const policy = { ...DEFAULT_ROOT_CONVERGENCE_POLICY, maxTotalTokens: 10, deadlineAt: "2026-07-21T09:00:00Z" };

  assert.equal(assessRootConvergence({ view, now: "2026-07-21T10:00:00Z", nextStageReservedTotalTokens: 1, policy }).trigger, "deadline_exceeded");
  assert.equal(assessRootConvergence({ view: { ...view, root: { ...view.root, issue: { ...view.root.issue, status_name: "Canceled" } } }, now: "2026-07-21T08:00:00Z", nextStageReservedTotalTokens: 1, policy }).trigger, "root_canceled");
  assert.equal(assessRootConvergence({ view, now: "2026-07-21T08:00:00Z", nextStageReservedTotalTokens: 11, policy }).trigger, "token_budget");
});

function rootView(cycles: RootCycleView[]): RootDagView {
  return {
    root: { issue: { status_name: "In Progress", issue_id: "root-1" } as RootDagView["root"]["issue"], records: [] },
    statusCatalog: [],
    cycles,
    relations: [],
    git: { head: "commit-1", branch: "symphony/root-1", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } },
    observedAt: "2026-07-21T09:00:00Z",
  };
}

function cycle(issueId: string, order: number, statusName: string, records: ManagedRecord[]): RootCycleView {
  return {
    issue: { issue_id: issueId, order, status_name: statusName } as RootCycleView["issue"],
    marker: { kind: "cycle_marker", version: 1, rootIssueId: "root-1", cycleKey: issueId, trigger: order === 1 ? "initial" : "verify_changes", baselineRevision: "base-1" },
    records: records.filter((record): record is ProgressAssessment => record.kind === "progress_assessment"),
    nodes: [{
      issue: { issue_id: `${issueId}-verify`, issue_kind: "verify", status_name: "Done" } as RootCycleView["nodes"][number]["issue"],
      marker: { kind: "node_marker", version: 1, rootIssueId: "root-1", cycleIssueId: issueId, nodeKey: "verify-1", nodeKind: "verify", planContractDigest: "digest-1" },
      records: records.filter((record) => record.kind !== "progress_assessment"),
      blockedByIssueIds: [],
    }],
  };
}

function execution(stageExecutionId: string, cycleIssueId: string, reservedTotalTokens: number): StageExecutionRecord {
  return {
    kind: "stage_execution", version: 1, stageExecutionId, rootIssueId: "root-1", cycleIssueId,
    nodeIssueId: `${cycleIssueId}-verify`, stage: "verify", planContractDigest: "digest-1", contextDigest: `context:${stageExecutionId}`,
    sourceManifest: [], coverage: { isComplete: true, omissions: [] }, instructionSetId: "verify-v1", executionPolicyId: "profile:model",
    limits: { maxContextBytes: 1, maxResultBytes: 1, maxWallTimeMs: 1, maxToolCalls: 1, maxCommandDurationMs: 1, reservedTotalTokens, maxOutputTokens: 1 },
    repositoryRevision: "commit-1", startedAt: `2026-07-21T0${cycleIssueId === "cycle-1" ? "1" : "2"}:00:00Z`, deadlineAt: "2026-07-22T00:00:00Z",
  };
}

function terminal(stageExecutionId: string, cycleIssueId: string, totalTokens: number): StageTerminalRecord {
  return { kind: "stage_terminal", version: 1, stageExecutionId, rootIssueId: "root-1", cycleIssueId, nodeIssueId: `${cycleIssueId}-verify`, stage: "verify", contextDigest: `context:${stageExecutionId}`, outcome: "completed", completedAt: "2026-07-21T08:00:00Z", summary: "done", usage: { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens } };
}

function verifyResult(stageExecutionId: string, cycleIssueId: string, conclusion: VerifyResultRecord["conclusion"]): VerifyResultRecord {
  return { kind: "verify_result", version: 1, stageExecutionId, rootIssueId: "root-1", cycleIssueId, nodeIssueId: `${cycleIssueId}-verify`, conclusion, criteriaResults: [], checks: [], verifiedRevision: "commit-1" };
}

function finding(findingId: string, sourceVerifyId: string): FindingRecord {
  return { kind: "finding", version: 1, findingId, sourceVerifyId, category: "code", severity: "high", evidence: [{ evidenceId: `evidence:${findingId}`, sourceKind: "diff", sourceId: sourceVerifyId, summary: "Open.", artifactRevision: "commit-1" }], affectedScope: [{ scopeKind: "repository_path", identity: "apps/conductor" }], retryable: true, suggestedRemediation: ["Fix it."], acceptanceCriteria: [] };
}

function disposition(findingId: string, sourceVerifyId: string, value: "still_open" | "resolved" | "waived"): FindingDispositionRecord {
  return { kind: "finding_disposition", version: 1, findingId, sourceVerifyId, disposition: value, evidence: [{ evidenceId: `evidence:${findingId}:${sourceVerifyId}`, sourceKind: "log", sourceId: sourceVerifyId, summary: value, artifactRevision: "commit-1" }] };
}

function progress(cycleIssueId: string, currentVerifyId: string, isProgress: boolean): ProgressAssessment {
  return { kind: "progress_assessment", version: 1, rootIssueId: "root-1", previousVerifyId: "verify-none", currentVerifyId, resolvedFindingIds: [], previousPassedCriterionKeys: [], currentPassedCriterionKeys: [], previousPassedCheckKeys: [], currentPassedCheckKeys: [], isProgress };
}
