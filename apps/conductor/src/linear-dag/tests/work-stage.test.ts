import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { JsonValue } from "@symphony/contracts";
import type { GitWorkspaceInterface } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type {
  LinearGatewayInterface,
  LinearWorkflowMutationCommand,
  LinearWorkflowTreeSnapshot,
} from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { PerformerStageClientInterface } from "../../performer-stage-client/api/PerformerStageClientInterface.js";
import { runCommand } from "../../composition/CommandRunner.js";
import { NativeGitWorkspaceImpl } from "../../git-workspaces/internal/NativeGitWorkspaceImpl.js";
import { ShortProcessPerformerStageClientImpl } from "../../performer-stage-client/internal/ShortProcessPerformerStageClientImpl.js";
import { parseManagedRecord, serializeManagedRecord } from "../../root-workflow/api/index.js";
import type { PlanContract } from "../../root-workflow/api/ManagedRecords.js";
import type { WorkStageInput } from "../api/LinearDagExecutionInterface.js";
import { LinearDagExecutionImpl } from "../internal/LinearDagExecutionImpl.js";

const rootIssueId = "root-1";
const cycleIssueId = "cycle-1";
const planIssueId = "plan-1";
const readyWorkIssueId = "work-1";
const blockedWorkIssueId = "work-2";
const verifyIssueId = "verify-1";

test("executes one dependency-ready Work node and persists commit evidence before Done", async () => {
  const gateway = new WorkGateway(workTree());
  const performer: PerformerStageClientInterface = {
    async runStage(input) {
      const envelope = input.envelope as Record<string, JsonValue>;
      const target = envelope.target as Record<string, JsonValue>;
      const context = envelope.workflow_context as Record<string, JsonValue>;
      gateway.lastEnvelope = envelope;
      gateway.lastTargetIssueId = String(target.node_issue_id);
      gateway.performedTargets += 1;
      gateway.gitState.dirtyPaths = ["apps/conductor/src/changed.ts"];
      return {
        result: {
          protocol_version: "1",
          stage_execution_id: (envelope.stage_execution as Record<string, JsonValue>).stage_execution_id,
          stage: "work",
          root_issue_id: target.root_issue_id,
          cycle_issue_id: target.cycle_issue_id,
          node_issue_id: target.node_issue_id,
          context_digest: envelope.context_digest,
          completed_at: "2026-07-21T09:01:00Z",
          usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 17 },
          outcome: {
            kind: "work_completed",
            summary: "Implemented the selected Work node.",
            changed_paths: ["apps/conductor/src/changed.ts"],
            checks: [{ check_key: "work-check", command_or_method: "test", outcome: "passed", summary: "Work checks passed.", artifact_revision: context.git_baseline && "head-1" }],
            observed_workspace_revision: "head-1",
          },
        } as unknown as JsonValue,
      };
    },
    async cancelAndReap() {},
  };
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });

  const result = await execution.executeWorkStage(workInput());

  assert.equal(result.kind, "completed");
  assert.equal(result.workIssueId, readyWorkIssueId);
  assert.equal(result.commitRevision, "commit-1");
  assert.equal(gateway.performedTargets, 1);
  assert.equal(gateway.lastTargetIssueId, readyWorkIssueId);
  assert.equal(gateway.commitCalls, 1);
  assert.equal(gateway.gitState.dirtyPaths.length, 0);
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === readyWorkIssueId)?.status_name, "Done");
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === blockedWorkIssueId)?.status_name, "Todo");
  assert.equal(gateway.tree.comments.some((comment) => comment.body.includes('"kind":"work_completion"')), true);
  assert.equal((gateway.lastEnvelope?.stage_execution as Record<string, JsonValue>).stage, "work");
  assert.equal((gateway.lastEnvelope?.repository_context as Record<string, JsonValue>).workspace_access, "read_write");
  assert.deepEqual(gateway.lastEnvelope?.target, { root_issue_id: rootIssueId, cycle_issue_id: cycleIssueId, node_issue_id: readyWorkIssueId, plan_contract_digest: "digest-1" });
});

test("rejects a Work result that widens the approved scope before commit", async () => {
  const gateway = new WorkGateway(workTree());
  const performer: PerformerStageClientInterface = {
    async runStage(input) {
      const envelope = input.envelope as Record<string, JsonValue>;
      const target = envelope.target as Record<string, JsonValue>;
      gateway.lastEnvelope = envelope;
      gateway.lastTargetIssueId = String(target.node_issue_id);
      gateway.performedTargets += 1;
      return {
        result: {
          protocol_version: "1",
          stage_execution_id: (envelope.stage_execution as Record<string, JsonValue>).stage_execution_id,
          stage: "work",
          root_issue_id: target.root_issue_id,
          cycle_issue_id: target.cycle_issue_id,
          node_issue_id: target.node_issue_id,
          context_digest: envelope.context_digest,
          completed_at: "2026-07-21T09:01:00Z",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
          outcome: {
            kind: "work_completed", summary: "Changed an excluded path.", changed_paths: ["packages/podium/src/forbidden.ts"], checks: [], observed_workspace_revision: "head-1",
          },
        } as unknown as JsonValue,
      };
    },
    async cancelAndReap() {},
  };
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });

  await assert.rejects(execution.executeWorkStage(workInput()), /work_scope_invalid/u);
  assert.equal(gateway.commitCalls, 0);
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === readyWorkIssueId)?.status_name, "In Progress");
  assert.equal(gateway.tree.comments.some((comment) => comment.body.includes('"kind":"work_completion"')), false);
});

test("rejects a stale Work result before writing terminal or commit evidence", async () => {
  const gateway = new WorkGateway(workTree());
  const performer: PerformerStageClientInterface = {
    async runStage(input) {
      const envelope = input.envelope as Record<string, JsonValue>;
      const target = envelope.target as Record<string, JsonValue>;
      return {
        result: {
          protocol_version: "1",
          stage_execution_id: (envelope.stage_execution as Record<string, JsonValue>).stage_execution_id,
          stage: "work",
          root_issue_id: target.root_issue_id,
          cycle_issue_id: target.cycle_issue_id,
          node_issue_id: blockedWorkIssueId,
          context_digest: envelope.context_digest,
          completed_at: "2026-07-21T09:01:00Z",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
          outcome: { kind: "work_completed", summary: "Stale target.", changed_paths: [], checks: [], observed_workspace_revision: "head-1" },
        } as unknown as JsonValue,
      };
    },
    async cancelAndReap() {},
  };
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });

  await assert.rejects(execution.executeWorkStage(workInput()), /work_result_correlation_invalid/u);
  assert.equal(gateway.commitCalls, 0);
  assert.equal(gateway.tree.comments.some((comment) => comment.body.includes('"kind":"stage_terminal"')), false);
  assert.equal(gateway.tree.comments.some((comment) => comment.body.includes('"kind":"work_completion"')), false);
});

test("does not select a Work node whose Done predecessor lacks completion evidence", async () => {
  const tree = workTree();
  tree.issues.find((issue) => issue.issue_id === readyWorkIssueId)!.status_name = "Done";
  tree.issues.find((issue) => issue.issue_id === readyWorkIssueId)!.status_category = "completed";
  tree.issues.find((issue) => issue.issue_id === readyWorkIssueId)!.status_id = statusId("Done");
  tree.issues.find((issue) => issue.issue_id === readyWorkIssueId)!.status_position = catalog().find((status) => status.name === "Done")!.position;
  const gateway = new WorkGateway(tree);
  const performer: PerformerStageClientInterface = {
    async runStage() { throw new Error("performer_should_not_run"); },
    async cancelAndReap() {},
  };
  const execution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });

  await assert.rejects(execution.executeWorkStage(workInput()), /work_not_ready/u);
  assert.equal(gateway.commitCalls, 0);
  assert.equal(gateway.performedTargets, 0);
});

for (const rootStatus of ["Done", "Canceled"] as const) {
  test(`rejects a late Work Result after Root ${rootStatus}`, async () => {
    const gateway = new WorkGateway(workTree());
    const root = gateway.tree.issues.find((issue) => issue.issue_id === rootIssueId)!;
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

    assert.deepEqual(await execution.reconcileWork(workInput(), { stage_execution_id: "old-work-execution" } as unknown as JsonValue), {
      kind: "blocked",
      reason: "root_terminal_result_rejected",
    });
    assert.equal(gateway.writes.length, 0);
    assert.equal(gateway.commitCalls, 0);
  });
}

test("reconciles an orphaned Work execution into a fresh retry", async () => {
  const gateway = new WorkGateway(workTree());
  const performer: PerformerStageClientInterface = {
    async runStage() { throw new Error("performer_should_not_run"); },
    async cancelAndReap() {},
  };
  const firstExecution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });

  assert.deepEqual(await firstExecution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_in_progress" });
  assert.deepEqual(await firstExecution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_execution_created" });
  const orphanedExecution = parseExecution(gateway);

  const restartedExecution = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });
  assert.deepEqual(await restartedExecution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_orphaned_execution_terminal" });
  assert.deepEqual(await restartedExecution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_execution_created" });
  const retryExecution = latestExecution(gateway);
  const ready = await restartedExecution.reconcileWork(workInput(), undefined, undefined, retryExecution.stageExecutionId);
  assert.equal(ready.kind, "stage_ready");
  if (ready.kind !== "stage_ready") throw new Error("work_retry_not_ready");
  assert.equal((ready.envelope as Record<string, JsonValue>).stage_execution && ((ready.envelope as Record<string, JsonValue>).stage_execution as Record<string, JsonValue>).stage_execution_id, retryExecution.stageExecutionId);

  const restartedAgain = new LinearDagExecutionImpl({ linear: gateway, git: gateway.git, performer });
  assert.deepEqual(await restartedAgain.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_orphaned_execution_terminal" });

  const terminal = gateway.tree.comments.map((comment) => parseManagedRecord(comment.body)).find((record) => record.ok && record.value.kind === "stage_terminal" && record.value.stageExecutionId === orphanedExecution.stageExecutionId);
  assert.equal(terminal?.ok, true);
  if (!terminal?.ok || terminal.value.kind !== "stage_terminal") throw new Error("orphan_terminal_missing");
  assert.equal(terminal.value.outcome, "failed");
  assert.equal(terminal.value.failureCode, "orphaned_execution");
  assert.equal(terminal.value.usage.totalTokens, workInput().options.limits.reservedTotalTokens);
});

test("restarts after a real Performer exit using a real Git worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-work-recovery-"));
  const repository = path.join(root, "repository");
  await runCommand("git", ["init", "-b", "main", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repository, "README.md"), "initial\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", ["-C", repository, "commit", "-m", "initial"]);

  const git = new NativeGitWorkspaceImpl(repository, path.join(root, "worktrees"));
  const workspace = await git.ensureWorkspace({ rootIssueId, rootIdentifier: "ROOT-1", baseBranch: "main" });
  const performerScript = path.join(root, "performer-exits.js");
  await writeFile(performerScript, "process.exit(0);\n", { encoding: "utf8", mode: 0o700 });
  await chmod(performerScript, 0o700);
  const performer = new ShortProcessPerformerStageClientImpl({
    executable: process.execPath,
    argumentsPrefix: [performerScript],
    runtimeRoot: path.join(root, "runtime"),
    environment: () => ({ CODEX_HOME: path.join(root, "profile") }),
    startupDeadlineMs: 1_000,
    cancellationGraceMs: 100,
  });
  const tree = workTree();
  const ownership = tree.comments.find((comment) => comment.issue_id === rootIssueId && comment.body.includes('"kind":"root_ownership"'))!;
  const parsedOwnership = parseManagedRecord(ownership.body);
  assert.equal(parsedOwnership.ok, true);
  if (!parsedOwnership.ok || parsedOwnership.value.kind !== "root_ownership") throw new Error("root_ownership_fixture_invalid");
  parsedOwnership.value.deliveryBranch = workspace.branch;
  ownership.body = serializeManagedRecord(parsedOwnership.value);
  const gateway = new WorkGateway(tree, git);
  const input = { ...workInput(), workspace };
  const execution = new LinearDagExecutionImpl({ linear: gateway, git, performer });

  await assert.rejects(execution.executeWorkStage(input), /performer_stage_result_missing/u);

  const serializedLinearTree = JSON.stringify(gateway.tree);
  const restartedGateway = new WorkGateway(JSON.parse(serializedLinearTree) as LinearWorkflowTreeSnapshot, git);
  const restarted = new LinearDagExecutionImpl({ linear: restartedGateway, git, performer });
  assert.deepEqual(await restarted.reconcileWork(input), { kind: "mutation_applied", step: "work_orphaned_execution_terminal" });
  assert.deepEqual(await restarted.reconcileWork(input), { kind: "mutation_applied", step: "work_execution_created" });
  const retry = latestExecution(restartedGateway);
  const ready = await restarted.reconcileWork(input, undefined, undefined, retry.stageExecutionId);
  assert.equal(ready.kind, "stage_ready");
  assert.equal((await git.inspect(workspace)).status.items.length, 0);
  assert.notEqual(retry.stageExecutionId, "work-execution-1");
});

test("persists one suspended Work action and releases the Stage", async () => {
  const gateway = new WorkGateway(workTree());
  const execution = new LinearDagExecutionImpl({
    linear: gateway,
    git: gateway.git,
    performer: { async runStage() { throw new Error("must_not_run"); }, async cancelAndReap() {} },
  });

  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_in_progress" });
  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_execution_created" });
  const executionRecord = parseExecution(gateway);
  const result = suspendedWorkResult(executionRecord);

  assert.deepEqual(await execution.reconcileWork(workInput(), result), { kind: "mutation_applied", step: "work_stage_terminal" });
  assert.deepEqual(await execution.reconcileWork(workInput(), result), { kind: "mutation_applied", step: "work_human_action_created" });
  assert.deepEqual(await execution.reconcileWork(workInput(), result), { kind: "mutation_applied", step: "work_root_needs_info" });
  assert.deepEqual(await execution.reconcileWork(workInput(), result), {
    kind: "waiting_human",
    step: "work_suspension",
    cycleIssueId: cycleIssueId,
    workIssueId: readyWorkIssueId,
    actionId: "root-1:human:work-execution-1",
  });
  assert.equal(gateway.tree.comments.filter((comment) => comment.body.includes('"kind":"human_action"')).length, 1);
  assert.equal(gateway.tree.comments.filter((comment) => comment.body.includes('"kind":"stage_terminal"')).length, 1);
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === rootIssueId)?.status_name, "Needs Info");
});

test("requires a fresh Human answer before resuming Work and injects it only into the new context", async () => {
  const gateway = new WorkGateway(workTree());
  const execution = new LinearDagExecutionImpl({
    linear: gateway,
    git: gateway.git,
    performer: { async runStage() { throw new Error("must_not_run"); }, async cancelAndReap() {} },
  });
  const result = await suspendWork(gateway, execution);

  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "blocked", reason: "work_root_not_runnable" });
  restoreRootAfterHumanAnswer(gateway);
  gateway.tree.comments.push({ comment_id: "human-answer-1", issue_id: readyWorkIssueId, body: "Preserve the current compatibility behavior.", remote_version: "human-answer-1-version", updated_at: "2026-07-21T09:03:00Z" });

  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_execution_created" });
  const resumedExecution = latestExecution(gateway);
  const ready = await execution.reconcileWork(workInput(), undefined, undefined, resumedExecution.stageExecutionId);
  assert.equal(ready.kind, "stage_ready");
  if (ready.kind !== "stage_ready") throw new Error("work_stage_not_ready");
  const workflowContext = (ready.envelope as Record<string, JsonValue>).workflow_context as Record<string, JsonValue>;
  const envelope = ready.envelope as Record<string, JsonValue>;
  assert.deepEqual(workflowContext.resolved_human_input, [{
    action_id: "root-1:human:work-execution-1",
    request_kind: "needs_info",
    answer_or_decision: {
      source_id: "human-answer-1",
      source_kind: "comment",
      text: "Preserve the current compatibility behavior.",
      author_kind: "human",
      remote_version: "human-answer-1-version",
      updated_at: "2026-07-21T09:03:00Z",
    },
    target_context_digest: result.contextDigest,
  }]);
  assert.notEqual(envelope.context_digest, result.contextDigest);
  assert.equal((envelope.stage_execution as Record<string, JsonValue>).stage_execution_id, "work-execution-2");
});

test("settles missing Work usage at the reserved token ceiling", async () => {
  const gateway = new WorkGateway(workTree());
  const execution = new LinearDagExecutionImpl({
    linear: gateway,
    git: gateway.git,
    performer: {
      async runStage(input) {
        const envelope = input.envelope as Record<string, JsonValue>;
        const target = envelope.target as Record<string, JsonValue>;
        gateway.gitState.dirtyPaths = ["apps/conductor/src/changed.ts"];
        return { result: {
          protocol_version: "1", stage_execution_id: (envelope.stage_execution as Record<string, JsonValue>).stage_execution_id,
          stage: "work", root_issue_id: target.root_issue_id, cycle_issue_id: target.cycle_issue_id, node_issue_id: target.node_issue_id,
          context_digest: envelope.context_digest, completed_at: "2026-07-21T09:01:00Z",
          outcome: { kind: "work_completed", summary: "Completed without usage telemetry.", changed_paths: ["apps/conductor/src/changed.ts"], checks: [], observed_workspace_revision: "head-1",
          },
        } as unknown as JsonValue };
      },
      async cancelAndReap() {},
    },
  });

  await execution.executeWorkStage(workInput());
  const terminal = gateway.tree.comments.map((comment) => parseManagedRecord(comment.body)).find((record) => record.ok && record.value.kind === "stage_terminal");
  assert.equal(terminal?.ok, true);
  if (!terminal?.ok || terminal.value.kind !== "stage_terminal") throw new Error("stage_terminal_fixture_invalid");
  assert.equal(terminal.value.usage.totalTokens, workInput().options.limits.reservedTotalTokens);
});

test("converges a partially canceled Root on the next reconciliation", async () => {
  const gateway = new WorkGateway(workTree());
  const root = gateway.tree.issues.find((issue) => issue.issue_id === rootIssueId)!;
  const canceled = gateway.tree.status_catalog.find((candidate) => candidate.name === "Canceled")!;
  Object.assign(root, { status_id: canceled.status_id, status_name: canceled.name, status_category: canceled.category, status_position: canceled.position });
  const execution = new LinearDagExecutionImpl({
    linear: gateway,
    git: gateway.git,
    performer: { async runStage() { throw new Error("must_not_run"); }, async cancelAndReap() {} },
  });

  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "root_cancel_cycle" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === cycleIssueId)?.status_name, "Canceled");
  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "root_cancel_node" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === readyWorkIssueId)?.status_name, "Canceled");
  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "root_cancel_node" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === blockedWorkIssueId)?.status_name, "Canceled");
  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "root_cancel_node" });
  assert.equal(gateway.tree.issues.find((issue) => issue.issue_id === verifyIssueId)?.status_name, "Canceled");
  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "convergence_decision_persisted" });
});

function workInput(): WorkStageInput {
  return {
    rootIssueId,
    projectId: "project-1",
    workspace: { branch: "symphony/root-1", worktreePath: "/tmp/root-1", rootIssueId },
    options: {
      conductorShortHash: "cond",
      repositoryIdentity: "symphony",
      baseBranch: "main",
      performerProfileId: "profile-1",
      modelSettings: { model: "gpt-5.4", reasoningEffort: "high", isFastModeEnabled: false },
      limits: { maxContextBytes: 1_048_576, maxResultBytes: 262_144, maxWallTimeMs: 3_600_000, maxToolCalls: 10, maxCommandDurationMs: 300_000, reservedTotalTokens: 50_000, maxOutputTokens: 8_000 },
      instructionSetId: "work-v1",
      stageInstructions: "Implement the selected Work node within the approved scope.",
      now: () => "2026-07-21T09:00:00Z",
      stageId: (_root, _cycle, attempt) => `work-execution-${attempt}`,
    },
  };
}

function parseExecution(gateway: WorkGateway) {
  const comment = gateway.tree.comments.find((candidate) => candidate.body.includes('"kind":"stage_execution"'))!;
  const record = parseManagedRecord(comment.body);
  assert.equal(record.ok, true);
  if (!record.ok || record.value.kind !== "stage_execution") throw new Error("stage_execution_fixture_invalid");
  return record.value;
}

function latestExecution(gateway: WorkGateway) {
  const records = gateway.tree.comments.map((comment) => parseManagedRecord(comment.body)).flatMap((record) => record.ok && record.value.kind === "stage_execution" ? [record.value] : []);
  const execution = records.at(-1);
  if (!execution) throw new Error("stage_execution_fixture_missing");
  return execution;
}

function suspendedWorkResult(execution: ReturnType<typeof parseExecution>): JsonValue {
  return {
    protocol_version: "1",
    stage_execution_id: execution.stageExecutionId,
    stage: "work",
    root_issue_id: execution.rootIssueId,
    cycle_issue_id: execution.cycleIssueId,
    node_issue_id: execution.nodeIssueId,
    context_digest: execution.contextDigest,
    completed_at: "2026-07-21T09:02:00Z",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
    outcome: {
      kind: "suspended",
      request_kind: "needs_info",
      question_or_proposal: "Which API behavior should the Work node preserve?",
      reason: "The requirement is ambiguous.",
      impact: "Work cannot continue without a clarified requirement.",
    },
  } as unknown as JsonValue;
}

async function suspendWork(gateway: WorkGateway, execution: LinearDagExecutionImpl): Promise<ReturnType<typeof parseExecution>> {
  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_in_progress" });
  assert.deepEqual(await execution.reconcileWork(workInput()), { kind: "mutation_applied", step: "work_execution_created" });
  const executionRecord = parseExecution(gateway);
  const result = suspendedWorkResult(executionRecord);
  assert.deepEqual(await execution.reconcileWork(workInput(), result), { kind: "mutation_applied", step: "work_stage_terminal" });
  assert.deepEqual(await execution.reconcileWork(workInput(), result), { kind: "mutation_applied", step: "work_human_action_created" });
  assert.deepEqual(await execution.reconcileWork(workInput(), result), { kind: "mutation_applied", step: "work_root_needs_info" });
  return executionRecord;
}

function restoreRootAfterHumanAnswer(gateway: WorkGateway): void {
  const root = gateway.tree.issues.find((issue) => issue.issue_id === rootIssueId)!;
  const status = gateway.tree.status_catalog.find((candidate) => candidate.name === "In Progress")!;
  Object.assign(root, { status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, remote_version: "root-version-after-human" });
}

function workTree(): LinearWorkflowTreeSnapshot {
  const contract = planContract();
  const issues = [
    issue(rootIssueId, "root", "In Progress", 0),
    issue(cycleIssueId, "cycle", "Executing", 1, "root-1:cycle:cycle-1", rootIssueId),
    issue(planIssueId, "plan", "Done", 1, "root-1:plan:bootstrap", cycleIssueId),
    issue(readyWorkIssueId, "work", "Todo", 2, "root-1:work:cycle-1:one", cycleIssueId),
    issue(blockedWorkIssueId, "work", "Todo", 3, "root-1:work:cycle-1:two", cycleIssueId),
    issue(verifyIssueId, "verify", "Todo", 4, "root-1:verify:cycle-1", cycleIssueId),
  ];
  return {
    root_issue_id: rootIssueId,
    status_catalog: catalog(),
    issues,
    comments: [
      comment(rootIssueId, "ownership", { kind: "root_ownership", version: 1, rootIssueId, conductorId: "conductor-1", performerProfileId: "profile-1", deliveryBranch: "symphony/root-1", ownerGeneration: "generation-1" }),
      comment(cycleIssueId, "cycle-marker", { kind: "cycle_marker", version: 1, rootIssueId, cycleKey: "cycle-1", trigger: "initial", baselineRevision: "head-1" }),
      comment(planIssueId, "plan-marker", { kind: "node_marker", version: 1, rootIssueId, cycleIssueId, nodeKey: "plan-1", nodeKind: "plan", planContractDigest: "digest-1" }),
      comment(planIssueId, "plan-contract", contract),
      comment(readyWorkIssueId, "work-one-marker", { kind: "node_marker", version: 1, rootIssueId, cycleIssueId, nodeKey: "one", nodeKind: "work", planContractDigest: "digest-1" }),
      comment(blockedWorkIssueId, "work-two-marker", { kind: "node_marker", version: 1, rootIssueId, cycleIssueId, nodeKey: "two", nodeKind: "work", planContractDigest: "digest-1" }),
      comment(verifyIssueId, "verify-marker", { kind: "node_marker", version: 1, rootIssueId, cycleIssueId, nodeKey: "verify-1", nodeKind: "verify", planContractDigest: "digest-1" }),
    ],
    relations: [
      relation("plan-work-one", planIssueId, readyWorkIssueId),
      relation("plan-work-two", planIssueId, blockedWorkIssueId),
      relation("work-one-two", readyWorkIssueId, blockedWorkIssueId),
      relation("work-one-verify", readyWorkIssueId, verifyIssueId),
      relation("work-two-verify", blockedWorkIssueId, verifyIssueId),
    ],
    observed_at: "2026-07-21T09:00:00Z",
  };
}

function planContract(): PlanContract {
  return {
    kind: "plan_contract", version: 1, rootIssueId, cycleIssueId, planContractDigest: "digest-1",
    objectiveSummary: "Deliver the Root objective.", includedScope: ["apps/conductor"], excludedScope: ["packages/podium"],
    acceptanceCriteria: [{ criterionKey: "root", statement: "The Root is delivered.", verificationMethod: "verify" }],
    workNodes: [
      { workKey: "one", title: "Implement one", description: "Implement the first Work node.", acceptanceCriteria: [{ criterionKey: "one", statement: "One is complete.", verificationMethod: "test" }], dependencyWorkKeys: [] },
      { workKey: "two", title: "Implement two", description: "Implement the second Work node.", acceptanceCriteria: [{ criterionKey: "two", statement: "Two is complete.", verificationMethod: "test" }], dependencyWorkKeys: ["one"] },
    ],
    verifyNode: { title: "Verify the Root", acceptanceCriteria: [{ criterionKey: "verify", statement: "The Root verifies.", verificationMethod: "verify" }], requiredChecks: [] },
  };
}

class WorkGateway implements LinearGatewayInterface {
  readonly gitState = { head: "head-1", dirtyPaths: [] as string[] };
  readonly git: GitWorkspaceInterface;
  readonly writes: string[] = [];
  readonly tree: LinearWorkflowTreeSnapshot;
  lastEnvelope?: Record<string, JsonValue>;
  lastTargetIssueId?: string;
  performedTargets = 0;
  commitCalls = 0;

  constructor(tree: LinearWorkflowTreeSnapshot, git?: GitWorkspaceInterface) {
    this.tree = tree;
    this.git = git ?? {
      inspect: async () => ({ head: this.gitState.head, branch: "symphony/root-1", status: { items: this.gitState.dirtyPaths.map((path) => ` M ${path}`), returned: this.gitState.dirtyPaths.length, cap: 32, has_more: false, partial: false } }),
      diff: async (_workspace, options = {}) => {
        const paths = options.fromRevision === "head-1" && options.toRevision === "commit-1" ? this.gitState.dirtyPaths : this.gitState.dirtyPaths;
        return { text: paths.map((path) => `diff --git a/${path} b/${path}`).join("\n"), bytes: paths.length, cap: 65_536, partial: false };
      },
      checks: async (_workspace, names) => ({ items: names.map((name) => ({ name, status: "passed" as const })), returned: names.length, cap: 32, has_more: false, partial: false }),
      commit: async (input) => {
        this.commitCalls += 1;
        assert.equal(input.rootIssueId, rootIssueId);
        assert.deepEqual(input.allowedIssueIds, [readyWorkIssueId]);
        assert.equal(input.expectedHead, "head-1");
        this.gitState.head = "commit-1";
        this.gitState.dirtyPaths = [];
        return { kind: "committed" as const, commit: "commit-1" };
      },
    };
  }

  async readWorkflowIssueTree() { return structuredClone(this.tree); }
  async readFreshRootScope(): Promise<never> { throw new Error("unused"); }
  async read(): Promise<never> { throw new Error("unused"); }
  async mutate(): Promise<never> { throw new Error("unused"); }

  async mutateWorkflow(command: LinearWorkflowMutationCommand) {
    this.writes.push(command.writeId);
    if (command.kind === "update_workflow_issue") {
      const target = this.tree.issues.find((issue) => issue.issue_id === command.target.targetIssueId)!;
      const status = this.tree.status_catalog.find((candidate) => candidate.status_id === command.statusId)!;
      target.status_id = status.status_id;
      target.status_name = status.name;
      target.status_category = status.category;
      target.status_position = status.position;
      target.remote_version = `${target.issue_id}:${command.writeId}`;
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: target.issue_id, remoteVersion: target.remote_version } };
    }
    if (command.kind === "append_workflow_comment") {
      this.tree.comments.push({ comment_id: command.writeId, issue_id: command.target.targetIssueId, body: command.body, managed_marker: command.writeId, remote_version: `${command.writeId}:version`, updated_at: this.tree.observed_at });
      return { kind: "applied" as const, readBack: { writeId: command.writeId, targetIssueId: command.target.targetIssueId, remoteVersion: `${command.writeId}:version` } };
    }
    throw new Error(`unexpected_${command.kind}`);
  }
}

function issue(issueId: string, kind: "root" | "cycle" | "plan" | "work" | "verify", statusName: string, order: number, managedMarker?: string, parentIssueId?: string): LinearWorkflowTreeSnapshot["issues"][number] {
  const status = catalog().find((candidate) => candidate.name === statusName)!;
  return { issue_id: issueId, identifier: issueId.toUpperCase(), project_id: "project-1", ...(parentIssueId ? { parent_issue_id: parentIssueId } : {}), status_id: status.status_id, status_name: status.name, status_category: status.category, status_position: status.position, order, depth: kind === "root" ? 0 : kind === "cycle" ? 1 : 2, title: issueId, description: issueId, ...(managedMarker ? { managed_marker: managedMarker } : {}), issue_kind: kind, remote_version: `${issueId}-version`, updated_at: "2026-07-21T09:00:00Z" };
}

function comment(issueId: string, commentId: string, value: object) {
  return { comment_id: commentId, issue_id: issueId, body: serializeManagedRecord(value), managed_marker: `${rootIssueId}:${commentId}`, remote_version: `${commentId}-version`, updated_at: "2026-07-21T09:00:00Z" };
}

function relation(relationId: string, blocker: string, blocked: string) {
  return { relation_id: relationId, relation_kind: "blocks" as const, source_issue_id: blocker, target_issue_id: blocked };
}

function statusId(name: string) { return catalog().find((candidate) => candidate.name === name)!.status_id; }

function catalog(): LinearWorkflowTreeSnapshot["status_catalog"] {
  return ([
    ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"], ["Sealed", "started"], ["Executing", "started"], ["Verifying", "started"], ["In Progress", "started"], ["In Review", "started"], ["Needs Approval", "started"], ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"], ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"], ["Canceled", "canceled"], ["Failed", "canceled"],
  ] as const).map(([name, category], position) => ({ status_id: `status-${name.toLowerCase().replaceAll(" ", "-")}`, name, category, position }));
}
