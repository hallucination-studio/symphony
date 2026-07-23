import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeConductorPerformerPlanTurnRequest,
  decodeConductorPerformerVerifyTurnRequest,
  decodeConductorPerformerWorkTurnRequest,
  type JsonValue,
} from "@symphony/contracts";

import {
  PersistentPerformerAgentChannelFactory,
  type PerformerAgentChannelFactory,
} from "../internal/PerformerAgentChannel.js";
import type { RootReconcilerOpenInput } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import type { StageTurnInput } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { SessionPerformerAgentClientImpl } from "../internal/SessionPerformerAgentClientImpl.js";

function channelFactoryFor(
  respond: (input: { requestId: string; body: Record<string, unknown> }) => JsonValue | Promise<JsonValue>,
  calls?: Record<string, unknown>[],
): PerformerAgentChannelFactory {
  return {
    open() {
      return {
        async request(input) {
          calls?.push(input.body);
          return await respond({ requestId: input.requestId, body: input.body });
        },
        async close() {},
      };
    },
  };
}

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
        labels: [],
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
        labels: [],
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
        labels: [],
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
  const calls: Record<string, unknown>[] = [];
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({ CODEX_HOME: "/tmp/profile" }),
    channelFactory: channelFactoryFor(({ requestId }) => ({
      protocol_version: "1",
      request_id: requestId,
      kind: "root_reconciler_opened",
      root_issue_id: "root-1",
      reconciler_session_id: "session-1",
    }), calls),
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
  const sent = calls[0]!;
  assert.equal(sent.protocol_version, "1");
  assert.equal(sent.kind, "open_root_reconciler");
  assert.equal("payload" in sent, false);
  assert.equal(sent.root_issue_id, "root-1");
  assert.equal(sent.performer_profile_id, "profile-1");
});

test("agent client reuses one Profile channel for a Root session lifecycle", async () => {
  let openedChannels = 0;
  const requestKinds: string[] = [];
  const channelFactory: PerformerAgentChannelFactory = {
    open() {
      openedChannels += 1;
      return {
        async request({ requestId, body }) {
          requestKinds.push(String(body.kind));
          return (body.kind === "open_root_reconciler"
            ? {
              protocol_version: "1", request_id: requestId, kind: "root_reconciler_opened",
              root_issue_id: "root-1", reconciler_session_id: "session-1",
            }
            : {
              protocol_version: "1", request_id: requestId, kind: "root_reconciler_closed", root_issue_id: "root-1",
            }) as JsonValue;
        },
        async close() {},
      };
    },
  };
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory,
    deadlineMs: 30_000,
  });
  await client.openRootReconciler({
    protocolVersion: 1,
    requestId: "open-request",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
  });
  await client.closeRootReconciler({ requestId: "close-request", rootIssueId: "root-1", sessionId: "session-1" });
  assert.equal(openedChannels, 1);
  assert.deepEqual(requestKinds, ["open_root_reconciler", "close_root_reconciler"]);
});

test("agent client decodes direct role-specific results", async () => {
  const channelFactory = channelFactoryFor(({ requestId, body }) => {
    const role = body.role as "plan" | "work" | "verify";
    if (role === "plan") decodeConductorPerformerPlanTurnRequest(body as JsonValue);
    if (role === "work") decodeConductorPerformerWorkTurnRequest(body as JsonValue);
    if (role === "verify") decodeConductorPerformerVerifyTurnRequest(body as JsonValue);
    return directStageResult(role, requestId) as JsonValue;
  });
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory,
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
  const calls: Record<string, unknown>[] = [];
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => {
      const role = body.role as "plan" | "work" | "verify";
      if (role === "plan") decodeConductorPerformerPlanTurnRequest(body as JsonValue);
      if (role === "work") decodeConductorPerformerWorkTurnRequest(body as JsonValue);
      if (role === "verify") decodeConductorPerformerVerifyTurnRequest(body as JsonValue);
      return directStageResult(role, requestId) as JsonValue;
    }, calls),
    deadlineMs: 30_000,
  });

  await client.executePlanTurn(stageInput("plan"));
  await client.executeWorkTurn(stageInput("work"));
  await client.executeVerifyTurn(stageInput("verify"));

  const requests = calls;
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
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId }) => ({
      protocol_version: "1",
      request_id: requestId,
      kind: "stage_result",
      result: directStageResult("plan", requestId),
    }) as JsonValue),
    deadlineMs: 30_000,
  });

  await assert.rejects(client.executePlanTurn(stageInput("plan")), /unknown field|expected exactly one union variant|stage_result/u);
});

test("agent client normalizes the Root directive wire fields", async () => {
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => body.kind === "open_root_reconciler"
      ? {
        protocol_version: "1", request_id: requestId, kind: "root_reconciler_opened",
        root_issue_id: "root-1", reconciler_session_id: "session-1",
      }
      : {
        protocol_version: "1", request_id: requestId, root_directive_id: "directive-1",
        reconciler_session_id: "session-1", reconciler_turn_id: "turn-1", based_on_root_tree_digest: "tree-1",
        rationale: "execute the plan", evidence_refs: [], comment_dispositions: [], external_change_dispositions: [],
        action: {
          kind: "execute_plan", cycle_issue_id: "cycle-1", plan_issue_id: "plan-1", plan_goal: "plan",
          required_outputs: [], prior_plan_result_ids: [], human_resolution_ids: [],
        },
      } as JsonValue),
    deadlineMs: 30_000,
  });
  await client.openRootReconciler({
    protocolVersion: 1,
    requestId: "open-request",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
  });

  const result = await client.advanceRootReconciler({
    requestId: "advance-request",
    sessionId: "session-1",
    observation: {
      root: { issueId: "root-1", title: "Root", description: "Root" } as never,
      tree: {
        root_issue_id: "root-1", status_catalog: [], issues: [{ issue_id: "root-1", issue_kind: "root", title: "Root", description: "Root", status: "In Progress" }], comments: [], relations: [], observed_at: "2026-07-23T00:00:00Z",
      },
      git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } },
      observedAt: "2026-07-23T00:00:00Z", treeDigest: "tree-1", complete: true,
      protocolVersion: 1, requestId: "observation-request", reconcilerSessionId: "session-1", reconcilerTurnId: "turn-1",
      cycles: [], rootHumanActions: [], pendingUserComments: [], externalLinearChanges: [], acceptedDirectives: [],
      rootReconcilerFailures: [], reconcilerReplies: [], limits: {
        maxObservationBytes: 1, maxDirectiveBytes: 1, maxTurnWallTimeMs: 1, reservedTotalTokens: 1,
      },
    } as never,
  });

  assert.equal(result.directive.action.kind, "execute_plan");
  assert.equal(result.directive.action.planIssueId, "plan-1");
  assert.equal(result.directive.action.cycleIssueId, "cycle-1");
});

test("agent client preserves the structured Performer error code", async () => {
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId }) => ({
      protocol_version: "1",
      request_id: requestId,
      kind: "error",
      code: "provider_turn_failed",
      sanitized_reason: "The Provider turn failed.",
      retryable: true,
    }) as JsonValue),
    deadlineMs: 30_000,
  });

  await assert.rejects(client.executePlanTurn(stageInput("plan")), /provider_turn_failed/u);
});

test("persistent Performer channel keeps one process across multiple requests", async () => {
  const script = [
    "const readline=require('node:readline');",
    "readline.createInterface({input:process.stdin}).on('line',line=>{",
    "const request=JSON.parse(line);",
    "process.stdout.write(JSON.stringify({protocol_version:'1',request_id:request.request_id,kind:'echo',pid:process.pid})+'\\n');",
    "});",
  ].join("");
  const channel = new PersistentPerformerAgentChannelFactory(["-e", script]).open({
    executable: process.execPath,
    environment: { ...process.env },
  });

  const first = await channel.request({ requestId: "first", body: { request_id: "first" }, deadlineMs: 5_000 });
  const second = await channel.request({ requestId: "second", body: { request_id: "second" }, deadlineMs: 5_000 });
  assert.equal((first as { request_id: string }).request_id, "first");
  assert.equal((second as { request_id: string }).request_id, "second");
  assert.equal((first as { pid: number }).pid, (second as { pid: number }).pid);
  await channel.close(1_000);
});
