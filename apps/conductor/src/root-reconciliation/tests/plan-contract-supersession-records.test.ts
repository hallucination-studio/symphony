import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { directiveMaterializationComplete } from "../internal/RootReconciliationRuntime.js";
import type { RootDirective } from "../api/RootReconciliationContracts.js";
import {
  parseManagedRecord,
  planContractSupersessionId,
  renderWorkflowIssueDescription,
  serializeManagedRecord,
} from "../api/index.js";

test("Plan Contract supersession records round-trip as closed managed records", () => {
  const record = {
    kind: "plan_contract_supersession" as const,
    version: 1 as const,
    supersessionId: "supersession-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    supersededPlanContractDigest: "contract-old",
    sourceRootDirectiveId: "directive-1",
    freshPlanIssueId: "plan-1",
    supersededAt: "2026-07-25T00:00:03Z",
  };

  assert.deepEqual(parseManagedRecord(serializeManagedRecord(record)), { ok: true, value: record });
});

test("Plan Contract supersession records reject speculative successor facts", () => {
  assert.throws(() => serializeManagedRecord({
    kind: "plan_contract_supersession" as const,
    version: 1 as const,
    supersessionId: "supersession-1",
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    supersededPlanContractDigest: "contract-old",
    sourceRootDirectiveId: "directive-1",
    freshPlanIssueId: "plan-1",
    supersededAt: "2026-07-25T00:00:03Z",
    freshPlanExecutionId: "execution-not-yet-real",
  }), /managed_record_unknown_field:freshPlanExecutionId/u);
});

test("Plan Contract supersession identity is stable and bounded", () => {
  assert.equal(planContractSupersessionId({
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    rootDirectiveId: "directive-1",
    supersededPlanContractDigest: "contract-old",
  }), "13219e90d8c41aa8ff47c59225b7f04d8832868112c6d12919068868b9647a8c");
});

test("replan completion requires matching durable supersession and timeline records", () => {
  const directive = replanDirective();
  const tree = replanTree();

  assert.equal(directiveMaterializationComplete(directive, tree), false);

  tree.comments.push({
    comment_id: "supersession-1",
    issue_id: "plan-1",
    body: serializeManagedRecord({
      kind: "plan_contract_supersession" as const,
      version: 1 as const,
      supersessionId: planContractSupersessionId({
        rootIssueId: "root-1",
        cycleIssueId: "cycle-1",
        rootDirectiveId: "directive-1",
        supersededPlanContractDigest: "contract-old",
      }),
      rootIssueId: "root-1",
      cycleIssueId: "cycle-1",
      supersededPlanContractDigest: "contract-old",
      sourceRootDirectiveId: "directive-1",
      freshPlanIssueId: "plan-1",
      supersededAt: "2026-07-25T00:00:03Z",
    }),
    author_kind: "symphony",
    author_id: "symphony",
    thread_root_comment_id: "supersession-1",
    thread_state: "unresolved",
    reactions: [],
    created_at: "2026-07-25T00:00:03Z",
    remote_version: "supersession-v1",
    updated_at: "2026-07-25T00:00:03Z",
  });

  assert.equal(directiveMaterializationComplete(directive, tree), false);

  const timelineEventId = createHash("sha256")
    .update(["decision_accepted", "root-1", "cycle-1", "directive-1"].join("\0"), "utf8")
    .digest("hex");
  tree.comments.push({
    comment_id: "timeline-1",
    issue_id: "cycle-1",
    body: serializeManagedRecord({
      kind: "workflow_timeline" as const,
      version: 1 as const,
      timelineEventId,
      timelineKind: "cycle" as const,
      targetIssueId: "cycle-1",
      sourceRecordIds: ["directive-1"],
      sourceVersions: ["tree-v1"],
      writeId: timelineEventId,
      renderedSchemaVersion: "1" as const,
      occurredAt: "2026-07-25T00:00:03Z",
    }),
    author_kind: "symphony",
    author_id: "symphony",
    thread_root_comment_id: "timeline-1",
    thread_state: "unresolved",
    reactions: [],
    created_at: "2026-07-25T00:00:04Z",
    remote_version: "timeline-v1",
    updated_at: "2026-07-25T00:00:04Z",
  });

  assert.equal(directiveMaterializationComplete(directive, tree), true);

  const duplicate = replanDirective();
  if (duplicate.action.kind !== "replan_current_cycle") throw new Error("replan_action_expected");
  duplicate.action.supersededPlanContractIds.push("contract-old");
  assert.equal(directiveMaterializationComplete(duplicate, tree), false);

  const empty = replanDirective();
  if (empty.action.kind !== "replan_current_cycle") throw new Error("replan_action_expected");
  empty.action.supersededPlanContractIds = [] as unknown as [string, ...string[]];
  assert.equal(directiveMaterializationComplete(empty, tree), false);
});

function replanDirective(): RootDirective {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    rootDirectiveId: "directive-1",
    reconcilerSessionId: "session-1",
    reconcilerTurnId: "turn-1",
    modelTurn: {
      turnRecordId: "turn-record-1",
      role: "root_reconciler",
      rootIssueId: "root-1",
      reconcilerSessionId: "session-1",
      reconcilerTurnId: "turn-1",
      invocationState: "confirmed",
      model: "gpt",
      outcome: "directive_accepted",
      usage: { status: "unavailable", reason: "provider_omitted" },
      terminalAt: "2026-07-25T00:00:03Z",
    },
    basedOnTargetRootDigest: "tree-v1",
    rationale: "The existing Plan no longer fits the clarified requirement.",
    evidenceRefs: [],
    consumedInputIds: [],
    commentReplies: [],
    humanActionResolutions: [],
    action: {
      kind: "replan_current_cycle",
      cycleIssueId: "cycle-1",
      reason: "The existing Plan no longer fits the clarified requirement.",
      supersededPlanContractIds: ["contract-old"],
      invalidateExecutionIds: [],
      preserveEvidenceRefs: [],
      archiveOrRestoreOperations: [],
      planIssueId: "plan-1",
      freshPlanGoal: "Replan the clarified requirement.",
    },
  };
}

function replanTree(): LinearWorkflowTreeSnapshot {
  return {
    root_issue_id: "root-1",
    status_catalog: [],
    issues: [
      {
        issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "root-progress",
        status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
        title: "Root", description: "Root", labels: [], is_archived: false, issue_kind: "root", remote_version: "root-v1", updated_at: "2026-07-25T00:00:00Z",
      },
      {
        issue_id: "cycle-1", identifier: "SYM-2", project_id: "project-1", parent_issue_id: "root-1", status_id: "cycle-planning",
        status_name: "Planning", status_category: "started", status_position: 2, order: 1, depth: 1,
        title: "Cycle", description: "Cycle", labels: ["Cycle"], is_archived: false, issue_kind: "cycle", workflow_issue_key: "cycle-1", remote_version: "cycle-v1", updated_at: "2026-07-25T00:00:00Z",
      },
      {
        issue_id: "plan-1", identifier: "SYM-3", project_id: "project-1", parent_issue_id: "cycle-1", status_id: "plan-progress",
        status_name: "In Progress", status_category: "started", status_position: 3, order: 1, depth: 2,
        title: "Plan", description: renderWorkflowIssueDescription({
          issueKey: "plan-1", rootIssueId: "root-1", parentIssueId: "cycle-1", issueKind: "plan", markdown: "Replan the clarified requirement.",
        }),
        labels: ["Plan"], is_archived: false, issue_kind: "plan", workflow_issue_key: "plan-1", remote_version: "plan-v1", updated_at: "2026-07-25T00:00:00Z",
      },
    ],
    comments: [],
    relations: [],
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_at: "2026-07-25T00:00:03Z",
  };
}
