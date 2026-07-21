import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@symphony/contracts";
import type { GitWorkspaceInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearGatewayInterface, LinearWorkflowMutationCommand, LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { PerformerStageClientInterface } from "../../performer-stage-client/api/PerformerStageClientInterface.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-workflow/api/index.js";
import type { PlanContract } from "../../root-workflow/api/ManagedRecords.js";
import { DEFAULT_ROOT_CONVERGENCE_POLICY } from "../../root-workflow/internal/RootConvergencePolicy.js";
import type { VerifyStageInput } from "../api/LinearDagExecutionInterface.js";
import { LinearDagExecutionImpl } from "../internal/LinearDagExecutionImpl.js";

test("executes Verify against an immutable revision and writes the accepted conclusion", async () => {
  const gateway = new VerifyGateway();
  const performer: PerformerStageClientInterface = {
    async runStage(input) {
      const envelope = input.envelope as Record<string, JsonValue>;
      const target = envelope.target as Record<string, JsonValue>;
      const execution = envelope.stage_execution as Record<string, JsonValue>;
      gateway.lastEnvelope = envelope;
      return { result: {
        protocol_version: "1", stage_execution_id: execution.stage_execution_id, stage: "verify",
        root_issue_id: target.root_issue_id, cycle_issue_id: target.cycle_issue_id, node_issue_id: target.node_issue_id,
        context_digest: envelope.context_digest, completed_at: "2026-07-21T09:02:00Z",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 1, total_tokens: 16 },
        outcome: {
          kind: "verify_completed", conclusion: "passed",
          criteria_results: [{ criterion_key: "verify", outcome: "passed", summary: "Verified." }],
          checks: [], new_findings: [], finding_dispositions: [], verified_revision: "commit-1",
        },
      } as unknown as JsonValue };
    },
    async cancelAndReap() {},
  };
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });

  const result = await execution.executeVerifyStage(verifyInput());

  assert.equal(result.kind, "completed");
  assert.equal(result.conclusion, "passed");
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "cycle-1")?.status_name, "Succeeded");
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "verify-1")?.status_name, "Done");
  assert.equal(gateway.tree.comments.some((comment) => comment.body.includes('"kind":"verify_result"')), true);
  assert.equal(gateway.lastEnvelope?.stage_execution && (gateway.lastEnvelope.stage_execution as Record<string, JsonValue>).stage, "verify");
  assert.equal((gateway.lastEnvelope?.workflow_context as Record<string, JsonValue>).artifact && ((gateway.lastEnvelope?.workflow_context as Record<string, JsonValue>).artifact as Record<string, JsonValue>).target_revision, "commit-1");
});

test("rejects a Verify result for a changed revision before persisting terminal evidence", async () => {
  const gateway = new VerifyGateway();
  gateway.resultRevision = "commit-2";
  const performer: PerformerStageClientInterface = {
    async runStage(input) {
      const envelope = input.envelope as Record<string, JsonValue>;
      const target = envelope.target as Record<string, JsonValue>;
      const execution = envelope.stage_execution as Record<string, JsonValue>;
      return { result: {
        protocol_version: "1", stage_execution_id: execution.stage_execution_id, stage: "verify",
        root_issue_id: target.root_issue_id, cycle_issue_id: target.cycle_issue_id, node_issue_id: target.node_issue_id,
        context_digest: envelope.context_digest, completed_at: "2026-07-21T09:02:00Z",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
        outcome: { kind: "verify_completed", conclusion: "passed", criteria_results: [{ criterion_key: "verify", outcome: "passed", summary: "Verified." }], checks: [], new_findings: [], finding_dispositions: [], verified_revision: gateway.resultRevision },
      } as unknown as JsonValue };
    },
    async cancelAndReap() {},
  };
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });

  await assert.rejects(execution.executeVerifyStage(verifyInput()), /verify_revision_invalid/u);
  assert.equal(gateway.tree.comments.some((comment) => comment.body.includes('"kind":"stage_terminal"') && comment.body.includes('"stage":"verify"')), false);
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "cycle-1")?.status_name, "Verifying");
});

test("rejects a durable Verify result that targets a different node during reconstruction", async () => {
  const gateway = new VerifyGateway();
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer: {
    async runStage(input) {
      const envelope = input.envelope as Record<string, JsonValue>;
      const target = envelope.target as Record<string, JsonValue>;
      const stageExecution = envelope.stage_execution as Record<string, JsonValue>;
      return { result: {
        protocol_version: "1", stage_execution_id: stageExecution.stage_execution_id, stage: "verify",
        root_issue_id: target.root_issue_id, cycle_issue_id: target.cycle_issue_id, node_issue_id: target.node_issue_id,
        context_digest: envelope.context_digest, completed_at: "2026-07-21T09:02:00Z",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
        outcome: { kind: "verify_completed", conclusion: "passed", criteria_results: [{ criterion_key: "verify", outcome: "passed", summary: "Verified." }], checks: [], new_findings: [], finding_dispositions: [], verified_revision: "commit-1" },
      } as unknown as JsonValue };
    },
    async cancelAndReap() {},
  } });

  await execution.executeVerifyStage(verifyInput());
  const resultComment = gateway.tree.comments.find((comment) => comment.body.includes('"kind":"verify_result"'))!;
  const parsed = parseManagedRecord(resultComment.body);
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.value.kind !== "verify_result") throw new Error("verify_result_fixture_invalid");
  parsed.value.nodeIssueId = "work-1";
  resultComment.body = serializeManagedRecord(parsed.value);

  assert.deepEqual(await execution.reconcileVerify(verifyInput()), { kind: "blocked", reason: "verify_tree_invalid:verify_result_target_invalid" });
});

test("escalates a triggered convergence breaker in durable order", async () => {
  const gateway = new VerifyGateway();
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer: {
    async runStage() { throw new Error("must_not_run"); },
    async cancelAndReap() {},
  } }, undefined, undefined, { ...DEFAULT_ROOT_CONVERGENCE_POLICY, deadlineAt: "2026-07-21T08:59:59Z" });
  const input = verifyInput();

  assert.deepEqual(await execution.reconcileVerify(input), { kind: "mutation_applied", step: "convergence_decision_persisted" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "cycle-1")?.status_name, "Executing");
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "root-1")?.status_name, "In Progress");

  assert.deepEqual(await execution.reconcileVerify(input), { kind: "mutation_applied", step: "convergence_cycle_escalated" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "cycle-1")?.status_name, "Escalated");

  assert.deepEqual(await execution.reconcileVerify(input), { kind: "mutation_applied", step: "convergence_human_action_created" });
  assert.equal(gateway.tree.comments.filter((comment) => comment.body.includes('"kind":"human_action"')).length, 1);
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "root-1")?.status_name, "In Progress");

  assert.deepEqual(await execution.reconcileVerify(input), { kind: "mutation_applied", step: "convergence_root_needs_approval" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "root-1")?.status_name, "Needs Approval");

  const writesBeforeRetry = gateway.tree.comments.length;
  assert.deepEqual(await execution.reconcileVerify(input), { kind: "blocked", reason: "convergence_deadline_exceeded" });
  assert.equal(gateway.tree.comments.length, writesBeforeRetry);
});

test("creates one deterministic successor Cycle with repair provenance", async () => {
  const gateway = new VerifyGateway();
  prepareRepairTree(gateway.tree);
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer: {
    async runStage() { throw new Error("must_not_run"); },
    async cancelAndReap() {},
  } });
  const input = verifyInput();

  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "cycle-1")?.status_name, "Changes Required");

  assert.deepEqual(await execution.reconcileRoot(input), { kind: "mutation_applied", step: "repair_cycle_created" });
  const successor = gateway.tree.issues.find((issue) => issue.issue_kind === "cycle" && issue.issue_id !== "cycle-1");
  assert.ok(successor);
  assert.equal(successor?.status_name, "Draft");
  assert.equal(gateway.tree.issues.filter((issue) => issue.issue_kind === "cycle").length, 2);

  assert.deepEqual(await execution.reconcileRoot(input), { kind: "mutation_applied", step: "cycle_marker_created" });
  const markerComment = gateway.tree.comments.find((comment) => comment.issue_id === successor?.issue_id && comment.body.includes('"kind":"cycle_marker"'));
  assert.ok(markerComment);
  const marker = markerComment && parseManagedRecord(markerComment.body);
  assert.equal(marker?.ok, true);
  if (!marker?.ok || marker.value.kind !== "cycle_marker") throw new Error("successor_marker_missing");
  assert.equal(marker.value.trigger, "verify_changes");
  assert.equal(marker.value.predecessorCycleIssueId, "cycle-1");
  assert.equal(marker.value.predecessorPlanContractDigest, "digest-1");
  assert.equal(marker.value.predecessorVerifyResultId?.startsWith("verify-execution-"), true);
  assert.equal(marker.value.predecessorVerifiedRevision, "commit-1");
  assert.ok(marker.value.findingIds);
  assert.equal(marker.value.findingIds.length, 1);
  assert.equal(marker.value.repairGroupId?.startsWith("repair-group:"), true);

  await execution.reconcileRoot(input);
  assert.equal(gateway.tree.issues.filter((issue) => issue.issue_kind === "cycle").length, 2);
});

test("creates a Root approval when a breaker reaches a terminal repair Cycle", async () => {
  const gateway = new VerifyGateway();
  prepareRepairTree(gateway.tree);
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer: {
    async runStage() { throw new Error("must_not_run"); },
    async cancelAndReap() {},
  } }, undefined, undefined, { ...DEFAULT_ROOT_CONVERGENCE_POLICY, maxCyclesPerRoot: 1 });
  const input = verifyInput();

  assert.deepEqual(await execution.reconcileRoot(input), { kind: "mutation_applied", step: "convergence_decision_persisted" });
  assert.deepEqual(await execution.reconcileRoot(input), { kind: "mutation_applied", step: "convergence_human_action_created" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "cycle-1")?.status_name, "Changes Required");
  assert.deepEqual(await execution.reconcileRoot(input), { kind: "mutation_applied", step: "convergence_root_needs_approval" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === "root-1")?.status_name, "Needs Approval");
  assert.deepEqual(await execution.reconcileRoot(input), { kind: "blocked", reason: "convergence_max_cycles_per_root" });
});

for (const rootStatus of ["Done", "Canceled"] as const) {
  test(`rejects a late Verify Result after Root ${rootStatus}`, async () => {
    const gateway = new VerifyGateway();
    const root = gateway.tree.issues.find((issue) => issue.issue_id === "root-1")!;
    const status = gateway.tree.status_catalog.find((candidate) => candidate.name === rootStatus)!;
    Object.assign(root, {
      status_id: status.status_id,
      status_name: status.name,
      status_category: status.category,
      status_position: status.position,
    });
    const execution = new LinearDagExecutionImpl({
      linear: gateway,
      git: gateway.git,
      performer: { async runStage() { throw new Error("must_not_run"); }, async cancelAndReap() {} },
    });

    assert.deepEqual(await execution.reconcileVerify(verifyInput(), { stage_execution_id: "old-verify-execution" } as unknown as JsonValue), {
      kind: "blocked",
      reason: "root_terminal_result_rejected",
    });
  });
}

function verifyInput(): VerifyStageInput {
  return {
    rootIssueId: "root-1", projectId: "project-1",
    workspace: { branch: "symphony/root-1", worktreePath: "/tmp/root-1", rootIssueId: "root-1" },
    options: {
      conductorShortHash: "cond", repositoryIdentity: "symphony", baseBranch: "main", performerProfileId: "profile-1",
      modelSettings: { model: "gpt-5.4", reasoningEffort: "high", isFastModeEnabled: false },
      limits: { maxContextBytes: 1_048_576, maxResultBytes: 262_144, maxWallTimeMs: 3_600_000, maxToolCalls: 10, maxCommandDurationMs: 300_000, reservedTotalTokens: 50_000, maxOutputTokens: 8_000 },
      instructionSetId: "verify-v1", stageInstructions: "Verify the immutable artifact.", now: () => "2026-07-21T09:00:00Z", stageId: (_root, _cycle, attempt) => `verify-execution-${attempt}`,
    },
  };
}

function prepareRepairTree(tree: LinearWorkflowTreeSnapshot): void {
  const status = (name: string) => tree.status_catalog.find((candidate) => candidate.name === name)!;
  for (const issueId of ["verify-1"]) {
    const issue = tree.issues.find((candidate) => candidate.issue_id === issueId)!;
    const next = status("Done");
    Object.assign(issue, { status_id: next.status_id, status_name: next.name, status_category: next.category, status_position: next.position });
  }
  const cycle = tree.issues.find((issue) => issue.issue_id === "cycle-1")!;
  const changesRequired = status("Changes Required");
  Object.assign(cycle, { status_id: changesRequired.status_id, status_name: changesRequired.name, status_category: changesRequired.category, status_position: changesRequired.position });
  tree.comments.push(
    comment("verify-1", "verify-execution", { kind: "stage_execution", version: 1, stageExecutionId: "verify-execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "verify-1", stage: "verify", planContractDigest: "digest-1", contextDigest: "verify-digest", sourceManifest: [], coverage: { isComplete: true, omissions: [] }, instructionSetId: "verify-v1", executionPolicyId: "policy-1", limits: { maxContextBytes: 1, maxResultBytes: 1, maxWallTimeMs: 1, maxToolCalls: 1, maxCommandDurationMs: 1, reservedTotalTokens: 10, maxOutputTokens: 1 }, repositoryRevision: "commit-1", startedAt: "2026-07-21T08:00:00Z", deadlineAt: "2026-07-21T09:00:00Z" }),
    comment("verify-1", "verify-terminal", { kind: "stage_terminal", version: 1, stageExecutionId: "verify-execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "verify-1", stage: "verify", contextDigest: "verify-digest", outcome: "completed", completedAt: "2026-07-21T08:30:00Z", summary: "Verify found a repair.", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } }),
    comment("verify-1", "verify-result", { kind: "verify_result", version: 1, stageExecutionId: "verify-execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "verify-1", conclusion: "changes_required", criteriaResults: [{ criterionKey: "verify", outcome: "failed", summary: "Repair required." }], checks: [], verifiedRevision: "commit-1" }),
    comment("verify-1", "finding-1", { kind: "finding", version: 1, findingId: "finding:verify-execution-1:1", sourceVerifyId: "verify-execution-1", category: "code", severity: "high", evidence: [{ evidenceId: "evidence-1", sourceKind: "criterion", sourceId: "verify", summary: "Repair the verified issue.", artifactRevision: "commit-1" }], affectedScope: [{ scopeKind: "repository_path", identity: "apps/conductor" }], retryable: true, suggestedRemediation: ["Repair the verified issue."], acceptanceCriteria: [{ criterionKey: "repair", statement: "The issue is repaired.", verificationMethod: "verify" }] }),
    comment("cycle-1", "progress-1", { kind: "progress_assessment", version: 1, rootIssueId: "root-1", previousVerifyId: "verify-none", currentVerifyId: "verify-execution-1", resolvedFindingIds: [], previousPassedCriterionKeys: [], currentPassedCriterionKeys: [], previousPassedCheckKeys: [], currentPassedCheckKeys: [], isProgress: false }),
  );
}

class VerifyGateway implements LinearGatewayInterface {
  readonly tree = verifyTree();
  readonly gitState = { head: "commit-1" };
  readonly git: GitWorkspaceInterface = {
    inspect: async () => ({ head: this.gitState.head, branch: "symphony/root-1", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } }),
    diff: async () => ({ text: "diff --git a/apps/conductor/src/changed.ts b/apps/conductor/src/changed.ts", bytes: 1, cap: 65_536, partial: false }),
    checks: async () => ({ items: [], returned: 0, cap: 32, has_more: false, partial: false }),
    commit: async () => { throw new Error("verify_must_not_commit"); },
  };
  lastEnvelope?: Record<string, JsonValue>;
  resultRevision = "commit-1";
  async readWorkflowIssueTree() { return structuredClone(this.tree); }
  async readFreshRootScope(): Promise<never> { throw new Error("unused"); }
  async read(): Promise<never> { throw new Error("unused"); }
  async mutate(): Promise<never> { throw new Error("unused"); }
  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    if (command.kind === "create_workflow_issue") {
      const id = "cycle-2";
      const parent = this.tree.issues.find((issue) => issue.issue_id === command.parentIssueId)!;
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId)!;
      this.tree.issues.push({ issue_id: id, identifier: id.toUpperCase(), project_id: command.expectedProjectId, parent_issue_id: parent.issue_id, status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, order: command.order ?? this.tree.issues.length, depth: parent.depth + 1, title: command.title, description: command.description, managed_marker: command.managedMarker, issue_kind: command.issueKind, remote_version: `${id}-version`, updated_at: this.tree.observed_at });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: id, remoteVersion: `${id}-version` } };
    }
    if (command.kind === "update_workflow_issue") {
      const issue = this.tree.issues.find((candidate) => candidate.issue_id === command.target.targetIssueId)!;
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId)!;
      Object.assign(issue, { status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, remote_version: `${issue.issue_id}:${command.writeId}` });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: issue.issue_id, remoteVersion: issue.remote_version } };
    }
    if (command.kind === "append_workflow_comment") {
      this.tree.comments.push({ comment_id: command.writeId, issue_id: command.target.targetIssueId, body: command.body, managed_marker: command.writeId, remote_version: `${command.writeId}:version`, updated_at: this.tree.observed_at });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: `${command.writeId}:version` } };
    }
    throw new Error(`unexpected_${command.kind}`);
  }
}

function verifyTree(): LinearWorkflowTreeSnapshot {
  const statuses = (["Draft", "Todo", "Planning", "Sealed", "Executing", "Verifying", "In Progress", "In Review", "Needs Approval", "Needs Info", "Inconclusive", "Escalated", "Succeeded", "Changes Required", "Done", "Canceled", "Failed"] as const).map((name, position) => ({ status_id: `status-${name.toLowerCase().replaceAll(" ", "-")}`, name, category: (["Draft"] as string[]).includes(name) ? "backlog" as const : (["Todo"] as string[]).includes(name) ? "unstarted" as const : (["Succeeded", "Changes Required", "Done"] as string[]).includes(name) ? "completed" as const : (["Canceled", "Failed"] as string[]).includes(name) ? "canceled" as const : "started" as const, position }));
  const issue = (issueId: string, kind: "root" | "cycle" | "plan" | "work" | "verify", statusName: string, parentIssueId?: string) => { const status = statuses.find((candidate) => candidate.name === statusName)!; return { issue_id: issueId, identifier: issueId.toUpperCase(), project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}), status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, order: kind === "root" ? 0 : kind === "cycle" ? 1 : kind === "plan" ? 2 : kind === "work" ? 3 : 4, depth: kind === "root" ? 0 : kind === "cycle" ? 1 : 2, title: issueId, description: issueId, managed_marker: `root-1:${kind}:${issueId}`, issue_kind: kind, remote_version: `${issueId}-version`, updated_at: "2026-07-21T09:00:00Z" }; };
  const contract: PlanContract = { kind: "plan_contract", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", planContractDigest: "digest-1", objectiveSummary: "Deliver.", includedScope: ["apps/conductor"], excludedScope: [], acceptanceCriteria: [{ criterionKey: "root", statement: "Delivered.", verificationMethod: "verify" }], workNodes: [{ workKey: "one", title: "One", description: "One", acceptanceCriteria: [{ criterionKey: "one", statement: "One.", verificationMethod: "test" }], dependencyWorkKeys: [] }], verifyNode: { title: "Verify", acceptanceCriteria: [{ criterionKey: "verify", statement: "Verified.", verificationMethod: "verify" }], requiredChecks: [] } };
  return { root_issue_id: "root-1", status_catalog: statuses, issues: [issue("root-1", "root", "In Progress"), issue("cycle-1", "cycle", "Executing", "root-1"), issue("plan-1", "plan", "Done", "cycle-1"), issue("work-1", "work", "Done", "cycle-1"), issue("verify-1", "verify", "Todo", "cycle-1")], comments: [comment("root-1", "ownership", { kind: "root_ownership", version: 1, rootIssueId: "root-1", conductorId: "conductor-1", performerProfileId: "profile-1", deliveryBranch: "symphony/root-1", ownerGeneration: "generation-1" }), comment("cycle-1", "marker", { kind: "cycle_marker", version: 1, rootIssueId: "root-1", cycleKey: "cycle-1", trigger: "initial", baselineRevision: "base-1" }), comment("plan-1", "plan-marker", { kind: "node_marker", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeKey: "plan-1", nodeKind: "plan", planContractDigest: "digest-1" }), comment("plan-1", "contract", contract), comment("work-1", "work-marker", { kind: "node_marker", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeKey: "one", nodeKind: "work", planContractDigest: "digest-1" }), comment("work-1", "execution", { kind: "stage_execution", version: 1, stageExecutionId: "work-execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "work-1", stage: "work", planContractDigest: "digest-1", contextDigest: "work-digest", sourceManifest: [], coverage: { isComplete: true, omissions: [] }, instructionSetId: "work-v1", executionPolicyId: "policy-1", limits: { maxContextBytes: 1, maxResultBytes: 1, maxWallTimeMs: 1, maxToolCalls: 1, maxCommandDurationMs: 1, reservedTotalTokens: 10, maxOutputTokens: 1 }, repositoryRevision: "commit-1", startedAt: "2026-07-21T07:00:00Z", deadlineAt: "2026-07-21T08:00:00Z" }), comment("work-1", "completion", { kind: "work_completion", version: 1, stageExecutionId: "work-execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "work-1", workKey: "one", contextDigest: "work-digest", summary: "Done.", changedPaths: ["apps/conductor/src/changed.ts"], checks: [], commitRevision: "commit-1" }), comment("work-1", "terminal", { kind: "stage_terminal", version: 1, stageExecutionId: "work-execution-1", rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeIssueId: "work-1", stage: "work", contextDigest: "work-digest", outcome: "completed", completedAt: "2026-07-21T08:00:00Z", summary: "Done.", usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } }), comment("verify-1", "verify-marker", { kind: "node_marker", version: 1, rootIssueId: "root-1", cycleIssueId: "cycle-1", nodeKey: "verify-1", nodeKind: "verify", planContractDigest: "digest-1" })], relations: [{ relation_id: "plan-work", relation_kind: "blocks", source_issue_id: "plan-1", target_issue_id: "work-1" }, { relation_id: "work-verify", relation_kind: "blocks", source_issue_id: "work-1", target_issue_id: "verify-1" }], observed_at: "2026-07-21T09:00:00Z" };
}

function comment(issueId: string, commentId: string, value: object) { return { comment_id: commentId, issue_id: issueId, body: serializeManagedRecord(value), managed_marker: `root-1:${commentId}`, remote_version: `${commentId}-version`, updated_at: "2026-07-21T09:00:00Z" }; }
