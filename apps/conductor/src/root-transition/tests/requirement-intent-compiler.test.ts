import assert from "node:assert/strict";
import test from "node:test";

import type { RootReconciliationView, RootSemanticGateCommand, RootSemanticIntent } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { mechanicalWriteId } from "../internal/MechanicalWriteId.js";
import { RequirementIntentCompilerImpl } from "../internal/RequirementIntentCompilerImpl.js";

test("compiles initial requirement definition into one native Root effect", () => {
  const { command, intent, view } = fixture();
  const description = [
    "# Objective", "", "Build it", "", "## Requested Scope", "", "Conductor",
    "", "## Constraints", "", "- No compatibility shim",
    "", "## Acceptance Criteria", "", "- E2E reaches Plan",
  ].join("\n");

  assert.deepEqual(new RequirementIntentCompilerImpl().compile({ command, intent, view }), {
    kind: "effect",
    command: {
      kind: "update_workflow_issue",
      writeId: mechanicalWriteId(["root-1", "define-requirement", description]),
      expectedProjectId: "project-1",
      rootIssueId: "root-1",
      expectedRootRemoteVersion: "root-v1",
      target: {
        targetIssueId: "root-1",
        expectedRemoteVersion: "root-v1",
        expectedStatusId: "todo",
        expectedIsArchived: false,
      },
      statusId: "progress",
      title: "Root",
      description,
      labelNames: [],
      parentAssignment: { mode: "retain" },
      order: 0,
    },
  });
});

test("rejects stale subject, active topology, mismatched inputs and incompatible impact with zero effects", () => {
  const compiler = new RequirementIntentCompilerImpl();

  const stale = fixture();
  stale.command.subject.rootDefinitionVersionOrDigest = "root-old";
  assert.deepEqual(compiler.compile(stale), { kind: "invalid_intent", reason: "subject_stale" });

  const active = fixture();
  active.view.tree.issues.push({ ...active.view.tree.issues[0]!, issue_id: "cycle-1", identifier: "SYM-2", issue_kind: "cycle", parent_issue_id: "root-1" });
  assert.deepEqual(compiler.compile(active), { kind: "invalid_intent", reason: "topology_invalid" });

  const missingInput = fixture();
  missingInput.command.pendingInputRefs.push({ sourceKind: "comment_body", inputId: "input-1", nativeSourceIdentity: "comment-1", sourceVersionOrDigest: "body-1" });
  assert.deepEqual(compiler.compile(missingInput), { kind: "invalid_intent", reason: "input_disposition_invalid" });

  const impact = fixture();
  if (impact.intent.intent.kind !== "define_requirement") throw new Error("fixture_invalid");
  impact.intent.intent.activeCycleImpact = "requires_recovery";
  assert.deepEqual(compiler.compile(impact), { kind: "invalid_intent", reason: "impact_invalid" });
});

test("compiles an initial definition gap into one Root-scoped information request", () => {
  const input = fixture();
  input.intent.intent = {
    kind: "request_information",
    question: "Which deployment target should Symphony use?",
    context: "The complete Root facts do not identify a target.",
    options: ["staging", "production"],
  };

  assert.deepEqual(new RequirementIntentCompilerImpl().compile(input), {
    kind: "human_action_request",
    operationId: mechanicalWriteId(["root-1", "request-information", "intent-1"]),
    request: {
      actionKind: "information",
      targetIssueIds: ["root-1"],
      question: "Which deployment target should Symphony use?",
      context: "The complete Root facts do not identify a target.",
      options: ["staging", "production"],
      evidenceRefs: [],
    },
  });
});

test("requires exact pending-input coverage for an information request", () => {
  const input = fixture();
  input.intent.intent = { kind: "request_information", question: "Which target?", context: "Ambiguous comment.", options: [] };
  input.command.pendingInputRefs.push({
    sourceKind: "comment_body", inputId: "input-1", nativeSourceIdentity: "comment-1", sourceVersionOrDigest: "body-v1",
  });

  assert.deepEqual(new RequirementIntentCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "input_disposition_invalid",
  });

  input.intent.consumedInputIds = ["input-1"];
  input.intent.commentDispositions = [{
    kind: "answer_only", sourceInputId: "input-1",
    source: { kind: "comment_body", commentId: "comment-1", commentBodyDigest: "body-v1" }, answer: "Not enough information.",
  }];
  assert.deepEqual(new RequirementIntentCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "input_disposition_invalid",
  });
});

test("consumes Issue Activity without inventing a comment disposition", () => {
  const input = fixture();
  input.intent.intent = { kind: "request_information", question: "Confirm the new scope?", context: "A human changed the Root description.", options: [] };
  input.command.pendingInputRefs.push({
    sourceKind: "issue_activity", inputId: "activity-input-1", nativeSourceIdentity: "activity-1", sourceVersionOrDigest: "activity-v1",
  });
  input.intent.consumedInputIds = ["activity-input-1"];

  assert.equal(new RequirementIntentCompilerImpl().compile(input).kind, "human_action_request");
  assert.deepEqual(input.intent.commentDispositions, []);
});

function fixture() {
  const worktreeGate = { kind: "valid" as const, repositoryIdentity: "repository-1", branch: "root-1", headRevision: "head-1", isClean: true, changedPaths: [] };
  const view: RootReconciliationView = {
    root: { issueId: "root-1", identifier: "SYM-1", state: "Todo", updatedAt: "2026-07-29T00:00:00Z", projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [], isDelegatedToSymphony: true, isArchived: false },
    tree: {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "todo", name: "Todo", category: "unstarted", position: 1 },
        { status_id: "progress", name: "In Progress", category: "started", position: 2 },
      ],
      issues: [{
        issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "todo", status_name: "Todo", status_category: "unstarted",
        status_position: 1, order: 0, depth: 0, title: "Root", description: "Draft", labels: [], is_archived: false, issue_kind: "root",
        remote_version: "root-v1", created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:00Z",
      }],
      comments: [], relations: [], attachments: [], activities: [], source_manifest: [], coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:00Z",
    },
    worktreeGate,
    workspace: { branch: "root-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    git: { head: "head-1", branch: "root-1", status: { items: [], returned: 0, cap: 16, has_more: false, partial: false } },
    observedAt: "2026-07-29T00:00:00Z", treeDigest: "digest-1", complete: true,
  };
  const command: Extract<RootSemanticGateCommand, { semanticGate: "requirement_and_comment" }> = {
    semanticGate: "requirement_and_comment" as const,
    trigger: "initial_definition" as const,
    pendingInputRefs: [],
    expectedOutputContract: "requirement_and_comment_intent.v1" as const,
    subject: { rootDefinitionVersionOrDigest: "root-v1", activeCycleState: "absent" as const },
  };
  const intent: Extract<RootSemanticIntent, { semanticGate: "requirement_and_comment" }> = {
    protocolVersion: 1 as const, requestId: "request-1", kind: "requirement_and_comment_intent" as const,
    semanticGate: "requirement_and_comment" as const, intentId: "intent-1", rootIssueId: "root-1",
    reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1",
    modelTurn: {
      turnRecordId: "root-1:turn-1", role: "root_reconciler" as const, rootIssueId: "root-1", reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1",
      invocationState: "confirmed" as const, model: "gpt", outcome: "intent_accepted" as const,
      usage: { status: "unavailable" as const, reason: "provider_omitted" as const }, terminalAt: "2026-07-29T00:00:01Z",
    },
    basedOnTargetRootDigest: "digest-1", rationale: "Define it.", evidenceRefs: [], consumedInputIds: [], commentDispositions: [],
    intent: {
      kind: "define_requirement" as const,
      requirement: { objective: "Build it", requestedScope: "Conductor", constraints: ["No compatibility shim"], acceptanceCriteria: ["E2E reaches Plan"] },
      activeCycleImpact: "initial" as const,
    },
  };
  return { command, intent, view };
}
