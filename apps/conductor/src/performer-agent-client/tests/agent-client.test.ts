import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeConductorPerformerPlanTurnRequest,
  decodeConductorPerformerVerifyTurnRequest,
  decodeConductorPerformerWorkTurnRequest,
} from "@symphony/contracts";

import type { SerializedPerformerProcessRunnerInterface } from "../../performer-profiles/internal/SerializedPerformerProcessRunnerImpl.js";
import type { RootReconcilerOpenInput } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { StageTurnInput } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { SessionPerformerAgentClientImpl } from "../internal/SessionPerformerAgentClientImpl.js";

function stageInput(role: "plan" | "work" | "verify"): StageTurnInput {
  return {
    protocolVersion: 1,
    requestId: `${role}-request`,
    stageExecutionId: `${role}-execution`,
    roleSessionId: `${role}-session`,
    roleTurnId: `${role}-turn`,
    rootIssueId: "root-1",
    cycleIssueId: "cycle-1",
    targetIssueId: `${role}-1`,
    role,
    goal: "execute the selected role",
    requiredEvidenceRefs: [],
    tree: {
      root_issue_id: "root-1",
      status_catalog: [{ status_id: "todo", name: "Todo", category: "unstarted", position: 1 }],
      issues: [{
        issue_id: "root-1",
        identifier: "SYM-1",
        project_id: "project-1",
        status_id: "todo",
        status_name: "Todo",
        status_category: "unstarted",
        status_position: 1,
        order: 1,
        depth: 0,
        title: "Root",
        description: "Root description",
        is_archived: false,
        remote_version: "root-v1",
        updated_at: "2026-07-23T00:00:00Z",
      }, {
        issue_id: "cycle-1",
        identifier: "SYM-2",
        project_id: "project-1",
        parent_issue_id: "root-1",
        status_id: "todo",
        status_name: "Todo",
        status_category: "unstarted",
        status_position: 1,
        order: 1,
        depth: 1,
        title: "Cycle",
        description: "Cycle description",
        is_archived: false,
        issue_kind: "cycle",
        remote_version: "cycle-v1",
        updated_at: "2026-07-23T00:00:00Z",
      }, {
        issue_id: `${role}-1`,
        identifier: `SYM-${role === "plan" ? 3 : role === "work" ? 4 : 5}`,
        project_id: "project-1",
        parent_issue_id: "cycle-1",
        status_id: "todo",
        status_name: "Todo",
        status_category: "unstarted",
        status_position: 1,
        order: 1,
        depth: 2,
        title: role.charAt(0).toUpperCase() + role.slice(1),
        description: `${role} description`,
        is_archived: false,
        issue_kind: role,
        remote_version: `${role}-v1`,
        updated_at: "2026-07-23T00:00:00Z",
      }],
      comments: [],
      relations: [],
      observed_at: "2026-07-23T00:00:00Z",
    },
    git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } },
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
    observedTreeDigest: "tree-1",
    contextDigest: "context-1",
    executionPolicy: {
      sandbox_mode: role === "work" ? "workspace_write" : "read_only",
      workspace_access: role === "work" ? "read_write" : "read_only",
    },
  };
}

function directStageResult(role: "plan" | "work" | "verify", requestId: string) {
  return {
    protocol_version: "1",
    request_id: requestId,
    stage_execution_id: `${role}-execution`,
    role,
    role_session_id: `${role}-session`,
    role_turn_id: `${role}-turn`,
    root_issue_id: "root-1",
    cycle_issue_id: "cycle-1",
    target_issue_id: `${role}-1`,
    observed_tree_digest: "tree-1",
    context_digest: "context-1",
    completed_at: "2026-07-23T00:00:01Z",
    outcome: { kind: "canceled", sanitized_reason: "test cancellation" },
  };
}

test("agent client sends the closed direct OpenRootReconcilerRequest", async () => {
  const calls: Parameters<SerializedPerformerProcessRunnerInterface["run"]>[0][] = [];
  const runner: SerializedPerformerProcessRunnerInterface = {
    async run(input) {
      calls.push(input);
      return {
        stdout: JSON.stringify({
          protocol_version: "1",
          request_id: "request-1",
          kind: "root_reconciler_opened",
          root_issue_id: "root-1",
          reconciler_session_id: "session-1",
        }) + "\n",
        stderr: "",
      };
    },
    async cancelAndReap() {},
  };
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({ CODEX_HOME: "/tmp/profile" }),
    lane: runner,
    deadlineMs: 30_000,
  });
  const input: RootReconcilerOpenInput = {
    protocolVersion: 1,
    requestId: "request-1",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
  };

  assert.deepEqual(await client.openRootReconciler(input), { kind: "opened", sessionId: "session-1" });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(Buffer.from(calls[0]?.stdin ?? "").toString("utf8").trim()) as Record<string, unknown>;
  assert.equal(sent.protocol_version, "1");
  assert.equal(sent.kind, "open_root_reconciler");
  assert.equal("payload" in sent, false);
  assert.equal(sent.root_issue_id, "root-1");
  assert.equal(sent.performer_profile_id, "profile-1");
});

test("agent client decodes direct role-specific results", async () => {
  const runner: SerializedPerformerProcessRunnerInterface = {
    async run(input) {
      const sent = JSON.parse(Buffer.from(input.stdin ?? "").toString("utf8").trim()) as { request_id: string; role: "plan" | "work" | "verify" };
      const request = JSON.parse(Buffer.from(input.stdin ?? "").toString("utf8").trim());
      if (sent.role === "plan") decodeConductorPerformerPlanTurnRequest(request);
      if (sent.role === "work") decodeConductorPerformerWorkTurnRequest(request);
      if (sent.role === "verify") decodeConductorPerformerVerifyTurnRequest(request);
      return { stdout: `${JSON.stringify(directStageResult(sent.role, sent.request_id))}\n`, stderr: "" };
    },
    async cancelAndReap() {},
  };
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    lane: runner,
    deadlineMs: 30_000,
  });

  for (const role of ["plan", "work", "verify"] as const) {
    const result = role === "plan"
      ? await client.executePlanTurn(stageInput(role))
      : role === "work"
        ? await client.executeWorkTurn(stageInput(role))
        : await client.executeVerifyTurn(stageInput(role));
    assert.equal(result.role, role);
    assert.equal(result.resultId, `${role}-execution`);
    assert.equal(result.outcome.kind, "canceled");
  }
});

test("agent client sends role-specific closed stage contexts", async () => {
  const calls: Parameters<SerializedPerformerProcessRunnerInterface["run"]>[0][] = [];
  const runner: SerializedPerformerProcessRunnerInterface = {
    async run(input) {
      calls.push(input);
      const sent = JSON.parse(Buffer.from(input.stdin ?? "").toString("utf8").trim()) as { request_id: string; role: "plan" | "work" | "verify" };
      const request = JSON.parse(Buffer.from(input.stdin ?? "").toString("utf8").trim());
      if (sent.role === "plan") decodeConductorPerformerPlanTurnRequest(request);
      if (sent.role === "work") decodeConductorPerformerWorkTurnRequest(request);
      if (sent.role === "verify") decodeConductorPerformerVerifyTurnRequest(request);
      return { stdout: `${JSON.stringify(directStageResult(sent.role, sent.request_id))}\n`, stderr: "" };
    },
    async cancelAndReap() {},
  };
  const client = new SessionPerformerAgentClientImpl({ executable: "performer", environment: () => ({}), lane: runner, deadlineMs: 30_000 });

  await client.executePlanTurn(stageInput("plan"));
  await client.executeWorkTurn(stageInput("work"));
  await client.executeVerifyTurn(stageInput("verify"));

  const requests = calls.map((call) => JSON.parse(Buffer.from(call.stdin ?? "").toString("utf8").trim()) as Record<string, unknown>);
  assert.deepEqual(requests.map((request) => request.role), ["plan", "work", "verify"]);
  assert.equal("kind" in requests[0]!, false);
  assert.equal("payload" in requests[0]!, false);
  assert.deepEqual(Object.keys(requests[0]!.context as object).sort(), [
    "current_git_facts", "current_plan_issue", "cycle", "human_resolutions", "prior_plan_contracts",
    "prior_plan_results", "required_output", "root_contract", "unresolved_findings",
  ]);
  assert.deepEqual(Object.keys(requests[1]!.context as object).sort(), [
    "approved_plan_contract", "completed_work_evidence", "current_active_work_dag", "git_baseline",
    "human_resolutions", "prior_turn_results", "selected_work", "workspace_capability",
  ]);
  assert.deepEqual(Object.keys(requests[2]!.context as object).sort(), [
    "approved_plan_contract", "archived_cycle_nodes", "complete_active_cycle_dag", "completed_work_results",
    "human_resolutions", "immutable_target_revision", "repository_snapshot", "unresolved_findings",
    "verification_requirements",
  ]);
});

test("agent client rejects the retired stage_result envelope", async () => {
  const runner: SerializedPerformerProcessRunnerInterface = {
    async run(input) {
      const sent = JSON.parse(Buffer.from(input.stdin ?? "").toString("utf8").trim()) as { request_id: string };
      return {
        stdout: `${JSON.stringify({
          protocol_version: "1",
          request_id: sent.request_id,
          kind: "stage_result",
          result: directStageResult("plan", sent.request_id),
        })}\n`,
        stderr: "",
      };
    },
    async cancelAndReap() {},
  };
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    lane: runner,
    deadlineMs: 30_000,
  });

  await assert.rejects(client.executePlanTurn(stageInput("plan")), /unknown field|expected exactly one union variant|stage_result/u);
});
