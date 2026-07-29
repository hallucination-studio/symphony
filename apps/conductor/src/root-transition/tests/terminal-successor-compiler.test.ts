import assert from "node:assert/strict";
import test from "node:test";

import type {
  RootReconciliationView,
  RootSemanticGateCommand,
  RootSemanticIntent,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { TerminalSuccessorCompilerImpl } from "../internal/TerminalSuccessorCompilerImpl.js";

test("terminal successor compiles one bounded Planning Cycle that retains semantic intent", () => {
  const input = fixture();
  const result = new TerminalSuccessorCompilerImpl().compile(input);

  assert.equal(result.kind, "effect");
  if (result.kind !== "effect") return;
  assert.equal(result.command.kind, "create_workflow_issue");
  if (result.command.kind !== "create_workflow_issue") return;
  assert.equal(result.command.parentIssueId, "root-1");
  assert.equal(result.command.title, "Cycle 2");
  assert.equal(result.command.statusId, "planning");
  assert.deepEqual(result.command.labelNames, ["Terminal Review Successor", "symphony:kind/cycle"]);
  assert.match(result.command.description, /# Successor Objective\n\nCover rollout/u);
  assert.match(result.command.description, /## Required Outcomes\n\n- Rollout is verified/u);
  assert.match(result.command.description, /## Preserved Constraints\n\n- Preserve acceptance/u);
  assert.doesNotMatch(result.command.description, /writeId|remoteVersion|mutation|\{\s*"/u);
});

test("terminal successor rejects stale digest, stale Cycle version and a noncanonical subject", () => {
  const compiler = new TerminalSuccessorCompilerImpl();

  const staleDigest = fixture();
  staleDigest.intent.basedOnTargetRootDigest = "old-tree";
  assert.deepEqual(compiler.compile(staleDigest), { kind: "invalid_intent", reason: "subject_stale" });

  const staleVersion = fixture();
  staleVersion.command.subject.terminalCycleVersionOrDigest = "cycle-old";
  assert.deepEqual(compiler.compile(staleVersion), { kind: "invalid_intent", reason: "subject_stale" });

  const noncanonical = fixture();
  noncanonical.view.tree.issues.push(cycle("cycle-2", "Cycle 2", "cycle-2-v1", true, "2026-07-29T00:00:02Z"));
  assert.deepEqual(compiler.compile(noncanonical), { kind: "invalid_intent", reason: "subject_stale" });
});

test("terminal successor rejects another active lineage and an ambiguous Planning status", () => {
  const compiler = new TerminalSuccessorCompilerImpl();

  const activeHistory = fixture();
  activeHistory.view.tree.issues.unshift(cycle("cycle-0", "Cycle 0", "cycle-0-v1", false, "2026-07-28T00:00:00Z"));
  activeHistory.convergence.view.cycleCount = 2;
  assert.deepEqual(compiler.compile(activeHistory), { kind: "invalid_intent", reason: "topology_invalid" });

  const duplicatePlanning = fixture();
  duplicatePlanning.view.tree.status_catalog.push({
    status_id: "planning-duplicate", name: "Planning", category: "started", position: 2.5,
  });
  assert.deepEqual(compiler.compile(duplicatePlanning), { kind: "invalid_intent", reason: "status_catalog_invalid" });
});

test("terminal successor requires exact pending input and comment disposition coverage", () => {
  const input = fixture();
  input.command.pendingInputRefs.push({
    sourceKind: "comment_body", inputId: "comment-input-1", nativeSourceIdentity: "comment-1", sourceVersionOrDigest: "body-v1",
  });
  assert.deepEqual(new TerminalSuccessorCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "input_disposition_invalid",
  });

  input.intent.consumedInputIds = ["comment-input-1"];
  input.intent.commentDispositions = [{
    kind: "applied", sourceInputId: "comment-input-1",
    source: { kind: "comment_body", commentId: "wrong-comment", commentBodyDigest: "body-v1" },
    summary: "Applied to successor scope.",
  }];
  assert.deepEqual(new TerminalSuccessorCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "input_disposition_invalid",
  });
});

test("terminal successor rejects a terminal command frozen to a different Git revision", () => {
  const input = fixture();
  input.command.subject.exactRevision = "head-old";
  assert.deepEqual(new TerminalSuccessorCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "subject_stale",
  });
});

test("terminal successor rejects fresh native facts at the configured Cycle limit", () => {
  const input = fixture();
  input.command.subject.successorCyclePolicy = "cycle_limit_reached";
  const compileInput = {
    ...input,
    convergence: {
      policy: {
        maxCyclesPerRoot: 1, maxSameOpenFindingCycles: 2,
        maxCycleRepairAttempts: 2,
        deadlineAt: "2026-07-30T00:00:00Z",
      },
      view: {
        cycleCount: 1, openFindingPersistence: [], activeCycleRepairAttempts: 0, isDeadlineExceeded: false, rootIsCanceled: false,
      },
    },
  } as Parameters<TerminalSuccessorCompilerImpl["compile"]>[0];

  assert.deepEqual(new TerminalSuccessorCompilerImpl().compile(compileInput), {
    kind: "invalid_intent", reason: "successor_prohibited",
  });
});

test("terminal successor rejects fresh native facts after the Root deadline", () => {
  const input = fixture();
  input.command.subject.successorCyclePolicy = "root_deadline_reached";
  input.convergence.policy.deadlineAt = "2026-07-29T00:00:00Z";
  input.convergence.view.isDeadlineExceeded = true;

  assert.deepEqual(new TerminalSuccessorCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "successor_prohibited",
  });
});

test("terminal successor rejects a deadline classification inconsistent with fresh observation time", () => {
  const input = fixture();
  input.command.subject.successorCyclePolicy = "root_deadline_reached";
  input.convergence.view.isDeadlineExceeded = true;

  assert.deepEqual(new TerminalSuccessorCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "subject_stale",
  });
});

test("terminal successor rejects a contradictory active-Cycle convergence snapshot", () => {
  const input = fixture();
  input.convergence.view.activeCycleIssueId = "cycle-1";

  assert.deepEqual(new TerminalSuccessorCompilerImpl().compile(input), {
    kind: "invalid_intent", reason: "subject_stale",
  });
});

function fixture(): {
  command: Extract<RootSemanticGateCommand, { semanticGate: "terminal_review" }>;
  intent: Extract<RootSemanticIntent, { semanticGate: "terminal_review" }>;
  view: RootReconciliationView;
  convergence: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootConvergenceSnapshot;
} {
  const view: RootReconciliationView = {
    root: {
      issueId: "root-1", identifier: "SYM-1", state: "In Progress", updatedAt: "2026-07-29T00:00:01Z",
      projectId: "project-1", priority: "normal", blockers: [], rootConductorLabels: [],
      isDelegatedToSymphony: true, isArchived: false,
    },
    tree: {
      root_issue_id: "root-1",
      status_catalog: [
        { status_id: "progress", name: "In Progress", category: "started", position: 1 },
        { status_id: "planning", name: "Planning", category: "started", position: 2 },
      ],
      issues: [root(), cycle("cycle-1", "Cycle 1", "cycle-1-v1", false, "2026-07-29T00:00:01Z")],
      comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
      coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-29T00:00:01Z",
    },
    worktreeGate: {
      kind: "valid", repositoryIdentity: "repository-1", branch: "symphony/runs/sym-1",
      headRevision: "head-1", isClean: true, changedPaths: [],
    },
    workspace: { branch: "symphony/runs/sym-1", worktreePath: "/tmp/sym-1", rootIssueId: "root-1" },
    git: {
      head: "head-1", branch: "symphony/runs/sym-1",
      status: { items: [], returned: 0, cap: 16, has_more: false, partial: false },
    },
    observedAt: "2026-07-29T00:00:01Z", treeDigest: "tree-v1", complete: true,
  };
  return {
    command: {
      semanticGate: "terminal_review", trigger: "cycle_terminal", expectedOutputContract: "terminal_review_intent.v1",
      pendingInputRefs: [],
      subject: {
        terminalCycleIssueId: "cycle-1", terminalCycleVersionOrDigest: "cycle-1-v1", cycleOutcome: "successful",
        rootRequirementDigest: "requirement-v1", exactRevision: "head-1", verifyClassification: "passed",
        findingClassification: "none_open", successorCyclePolicy: "allowed",
      },
    },
    intent: {
      protocolVersion: 1, requestId: "request-1", intentId: "intent-1", rootIssueId: "root-1",
      reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1", modelTurn: {} as never,
      basedOnTargetRootDigest: view.treeDigest, rationale: "A bounded successor is required.", evidenceRefs: [],
      consumedInputIds: [], commentDispositions: [], kind: "terminal_review_intent", semanticGate: "terminal_review",
      intent: {
        kind: "start_successor_cycle", successorObjective: "Cover rollout",
        requiredOutcomes: ["Rollout is verified"], preservedConstraints: ["Preserve acceptance"],
      },
    },
    view,
    convergence: {
      policy: {
        maxCyclesPerRoot: 3, maxSameOpenFindingCycles: 2,
        maxCycleRepairAttempts: 2,
        deadlineAt: "2026-07-30T00:00:00Z",
      },
      view: {
        cycleCount: 1, openFindingPersistence: [], activeCycleRepairAttempts: 0, isDeadlineExceeded: false, rootIsCanceled: false,
      },
    },
  };
}

function root(): RootReconciliationView["tree"]["issues"][number] {
  return {
    issue_id: "root-1", identifier: "SYM-1", project_id: "project-1", status_id: "progress",
    status_name: "In Progress", status_category: "started", status_position: 1, order: 0, depth: 0,
    title: "Root", description: "Requirement", labels: [], is_archived: false, issue_kind: "root",
    remote_version: "root-v1", created_at: "2026-07-29T00:00:00Z", updated_at: "2026-07-29T00:00:01Z",
  };
}

function cycle(
  issueId: string,
  title: string,
  remoteVersion: string,
  isArchived: boolean,
  createdAt: string,
): RootReconciliationView["tree"]["issues"][number] {
  return {
    issue_id: issueId, identifier: `SYM-${issueId}`, project_id: "project-1", parent_issue_id: "root-1",
    status_id: "succeeded", status_name: "Succeeded", status_category: "completed", status_position: 3,
    order: 0, depth: 1, title, description: "Completed Cycle", labels: ["symphony:kind/cycle"],
    is_archived: isArchived, issue_kind: "cycle", remote_version: remoteVersion,
    created_at: createdAt, updated_at: createdAt,
  };
}
