import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeConductorPerformerOpenRootReconcilerRequest,
  decodeConductorPerformerPlanTurnRequest,
  decodeConductorPerformerVerifyTurnRequest,
  decodeConductorPerformerWorkTurnRequest,
  type JsonValue,
} from "@symphony/contracts";

import {
  PersistentPerformerAgentChannelFactory,
  type PerformerAgentChannelFactory,
} from "../internal/PerformerAgentChannel.js";
import type {
  RootCycleObservation,
  RootReconcilerOpenInput,
  StageTurnInput,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";
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

function stageInput(role: "plan" | "work" | "verify", goal = "execute the selected role"): StageTurnInput {
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
    goal,
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
        created_at: "2026-07-23T00:00:00Z",
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
        created_at: "2026-07-23T00:00:00Z",
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
        created_at: "2026-07-23T00:00:00Z",
        updated_at: "2026-07-23T00:00:00Z",
      }],
      comments: [],
      relations: [],
      attachments: [],
      activities: [],
      source_manifest: [],
      coverage: { is_complete: true, omissions: [] },
      observed_at: "2026-07-23T00:00:00Z",
    },
    git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } },
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
    observedTreeDigest: "tree-1",
    executionPolicy: {
      sandbox_mode: role === "work" ? "workspace_write" : "read_only",
      workspace_access: role === "work" ? "read_write" : "read_only",
    },
  };
}

function directStageResult(role: "plan" | "work" | "verify", requestId: string, contextDigest = "context-1") {
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
    context_digest: contextDigest,
    completed_at: "2026-07-23T00:00:01Z",
    model_turn: stageModelTurn(role, "canceled"),
    outcome: { kind: "canceled", sanitized_reason: "test cancellation" },
  };
}

function directStageResultForRequest(body: Record<string, unknown>, closed = false) {
  const role = body.role as "plan" | "work" | "verify";
  const result = directStageResult(role, body.request_id as string, body.context_digest as string);
  const modelTurn = {
    ...result.model_turn,
    turn_record_id: `${body.stage_execution_id}:${body.role_turn_id}`,
    stage_execution_id: body.stage_execution_id,
    role_session_id: body.role_session_id,
    role_turn_id: body.role_turn_id,
    outcome: closed ? "execution_failed" : "canceled",
  };
  return {
    ...result,
    stage_execution_id: body.stage_execution_id,
    role_session_id: body.role_session_id,
    role_turn_id: body.role_turn_id,
    target_issue_id: body.target_issue_id,
    observed_tree_digest: body.observed_tree_digest,
    model_turn: modelTurn,
    outcome: closed
      ? {
        kind: "execution_failed",
        error_code: "provider_session_lost",
        sanitized_reason: "The Provider session was lost.",
        retryable: true,
        continuity: { kind: "closed", append_outcome: "session_lost" },
      }
      : result.outcome,
  };
}

function stageModelTurn(
  role: "plan" | "work" | "verify",
  outcome: string,
) {
  return {
    turn_record_id: `${role}-execution:${role}-turn`,
    role,
    root_issue_id: "root-1",
    cycle_issue_id: "cycle-1",
    target_issue_id: `${role}-1`,
    stage_execution_id: `${role}-execution`,
    role_session_id: `${role}-session`,
    role_turn_id: `${role}-turn`,
    invocation_state: "confirmed",
    model: "gpt",
    outcome,
    usage: {
      status: "measured",
      input_tokens: 1,
      cached_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
      total_tokens: 2,
    },
    terminal_at: "2026-07-23T00:00:01Z",
  };
}

function completedPlanResult(requestId: string, contextDigest = "context-1") {
  return {
    protocol_version: "1",
    request_id: requestId,
    stage_execution_id: "plan-execution",
    role: "plan",
    role_session_id: "plan-session",
    role_turn_id: "plan-turn",
    root_issue_id: "root-1",
    cycle_issue_id: "cycle-1",
    target_issue_id: "plan-1",
    observed_tree_digest: "tree-1",
    context_digest: contextDigest,
    completed_at: "2026-07-23T00:00:01Z",
    model_turn: stageModelTurn("plan", "plan_completed"),
    outcome: {
      kind: "plan_completed",
      plan_contract: {
        objective: "Persist the complete Plan Contract.",
        included_scope: ["apps/conductor"],
        excluded_scope: [],
        assumptions: [],
        constraints: ["Use durable Linear facts."],
        acceptance_criteria: [{
          criterion_key: "contract-persisted",
          statement: "The complete Plan Contract is stored before review.",
          verification_method: "Read the Plan Contract record.",
        }],
        verification_requirements: ["npm test -w @symphony/conductor"],
      },
      proposed_work_dag: {
        work_nodes: [{
          proposal_key: "persist-contract",
          title: "Persist the Plan Contract",
          description: "Write the canonical Plan Contract record.",
          expected_outcome: "The contract can be reconstructed after restart.",
          required_checks: ["managed-record-read-back"],
          dependency_proposal_keys: [],
        }],
        dependency_edges: [],
        verify_node: {
          title: "Verify Plan Contract persistence",
          acceptance_criteria: [{
            criterion_key: "contract-read-back",
            statement: "The stored contract matches the Plan result.",
            verification_method: "Read the Plan Contract record.",
          }],
          required_checks: ["managed-record-read-back"],
        },
      },
      risks: [],
      required_permissions: [],
      evidence_refs: [],
    },
  };
}

function changesRequiredResult(requestId: string, contextDigest = "context-1") {
  return {
    protocol_version: "1",
    request_id: requestId,
    stage_execution_id: "verify-execution",
    role: "verify",
    role_session_id: "verify-session",
    role_turn_id: "verify-turn",
    root_issue_id: "root-1",
    cycle_issue_id: "cycle-1",
    target_issue_id: "verify-1",
    observed_tree_digest: "tree-1",
    context_digest: contextDigest,
    completed_at: "2026-07-23T00:00:01Z",
    model_turn: stageModelTurn("verify", "verify_changes_required"),
    outcome: {
      kind: "verify_changes_required",
      target_revision: "head-1",
      acceptance_results: [],
      findings: [{
        finding_id: "finding-1",
        category: "code",
        severity: "high",
        description: "Null input crashes the parser.",
        evidence_refs: [{ reference_id: "parser-regression", source_kind: "check" }],
        related_work_issue_ids: ["work-1"],
      }],
      checks: [],
    },
  };
}

function openInput(requestId = "request-1"): RootReconcilerOpenInput {
  return {
    protocolVersion: 1,
    requestId,
    reconcilerSessionId: "session-request-1",
    reconcilerTurnId: "turn-1",
    observedAt: "2026-07-23T00:00:00Z",
    rootIssueId: "root-1",
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
    bootstrap: bootstrap(),
    limits: {
      maxContextBytes: 8_388_608,
      maxResultBytes: 1_048_576,
      maxOutputTokens: 32_768,
      maxToolCalls: 0,
      maxWallTimeMs: 30_000,
      deadlineAt: "2026-07-23T00:05:00Z",
    },
  };
}

function bootstrap() {
  const issue = {
    issueId: "root-1", issueKind: "root" as const, title: "Root", description: "Root description",
    status: "Todo" as const, isArchived: false, labels: [], remoteVersion: "root-v1",
  };
  return {
    rootSnapshot: {
      root: {
        issue, objective: "Root description", scope: "Root", acceptanceCriteria: [], constraints: [],
        rootStatus: "Todo" as const,
        convergence: {
          policy: {
            maxCyclesPerRoot: 3,
            maxSameOpenFindingCycles: 2,
            maxConsecutiveNoProgress: 2,
            maxCycleRepairAttempts: 0,
            deadlineAt: "2026-07-24T00:00:00Z",
          },
          view: {
            cycleCount: 0,
            openFindingPersistence: [],
            consecutiveNoProgress: 0,
            activeCycleRepairAttempts: 0,
            isDeadlineExceeded: false,
            rootIsCanceled: false,
          },
        },
      },
      cycles: [], issues: [issue], relations: [], attachments: [], activities: [],
      userComments: [], userCommentThreadStates: [],
      worktreeGate: {
        kind: "valid" as const,
        repositoryIdentity: "repository-1",
        branch: "symphony/root-1",
        headRevision: "head-1",
        isClean: true,
        changedPaths: [],
      },
      mechanicalViolations: [],
    },
    sourceManifest: [], coverage: { isComplete: true, omissions: [] }, rootDigest: "tree-1", pendingInputIds: [],
  };
}

function rootDirective() {
  return {
    protocol_version: "1",
    request_id: "request-1",
    root_directive_id: "directive-1",
    reconciler_session_id: "session-1",
    reconciler_turn_id: "turn-1",
    model_turn: rootModelTurn("turn-1"),
    based_on_target_root_digest: "tree-1",
    rationale: "Open the root.",
    evidence_refs: [],
    consumed_input_ids: [],
    comment_replies: [],
    action: { kind: "wait", reason_code: "initial_bootstrap", blocking_fact_refs: [{ reference_id: "bootstrap", source_kind: "linear_issue" }] },
  };
}

function waitDirective(requestId: string, digest: string, turnId: string) {
  return {
    protocol_version: "1",
    request_id: requestId,
    root_directive_id: `directive-${turnId}`,
    reconciler_session_id: "session-1",
    reconciler_turn_id: turnId,
    model_turn: rootModelTurn(turnId),
    based_on_target_root_digest: digest,
    rationale: "Wait for the next durable fact.",
    evidence_refs: [],
    consumed_input_ids: [],
    comment_replies: [],
    action: { kind: "wait", reason_code: "human", blocking_fact_refs: [{ reference_id: "fact-1", source_kind: "result" }] },
  };
}

function rootModelTurn(turnId: string) {
  return {
    turn_record_id: `root-1:${turnId}`,
    role: "root_reconciler",
    root_issue_id: "root-1",
    reconciler_session_id: "session-1",
    reconciler_turn_id: turnId,
    invocation_state: "confirmed",
    model: "gpt",
    outcome: "directive_accepted",
    usage: { status: "unavailable", reason: "provider_omitted" },
    terminal_at: "2026-07-23T00:00:01Z",
  };
}

function rootFailure(requestId: string, turnId: string, targetRootDigest: string) {
  return {
    protocol_version: "1",
    request_id: requestId,
    kind: "root_reconciler_failed",
    root_issue_id: "root-1",
    failure: {
      failure_id: `root-1:${turnId}:failure`,
      reconciler_session_id: "session-1",
      reconciler_turn_id: turnId,
      target_root_digest: targetRootDigest,
      attempted_input_ids: [],
      model_turn: {
        ...rootModelTurn(turnId),
        outcome: "schema_invalid",
      },
      category: "schema_invalid",
      sanitized_reason: "The Root Reconciler response was invalid.",
      continuity: { kind: "closed", append_outcome: "session_lost" },
      failed_at: "2026-07-23T00:00:01Z",
    },
  };
}

function planFacts(): { cycle: RootCycleObservation } {
  const planIssue = {
    issueId: "plan-1",
    issueKind: "plan" as const,
    title: "Plan",
    description: [
      "# Objective",
      "Persist the complete Plan as native Linear facts.",
      "",
      "# Work",
      "- Persist the Plan on this Issue.",
      "",
      "# Verification",
      "- npm test -w @symphony/conductor",
    ].join("\n"),
    status: "In Review" as const,
    isArchived: false,
    labels: ["symphony:kind/plan"],
    remoteVersion: "plan-v1",
  };
  return {
    cycle: {
      cycleIssue: {
        issueId: "cycle-1", issueKind: "cycle", title: "Cycle", description: "Current Cycle",
        status: "In Progress", isArchived: false, labels: ["symphony:kind/cycle"], remoteVersion: "cycle-v1",
      },
      cycleStatus: "In Progress",
      isArchived: false,
      issues: [planIssue],
      relations: [],
    },
  };
}

test("agent client sends the closed direct OpenRootReconcilerRequest", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({ CODEX_HOME: "/tmp/profile" }),
    channelFactory: channelFactoryFor(({ requestId, body }) => {
      decodeConductorPerformerOpenRootReconcilerRequest(body as JsonValue);
      return {
        protocol_version: "1",
        request_id: requestId,
        kind: "root_reconciler_opened",
        reconciler_session_id: "session-1",
        bootstrap_root_digest: "tree-1",
        initial_result: rootDirective(),
      };
    }, calls),
    deadlineMs: 30_000,
  });
  const input = openInput();
  input.bootstrap.sourceManifest.push({
    sourceKind: "issue",
    sourceId: "root-1",
    sourceVersionOrDigest: "root-v1",
    actorKind: "human",
  });

  const opened = await client.openRootReconciler(input);
  assert.equal(opened.initialResult.kind, "directive");
  if (opened.initialResult.kind === "directive") assert.equal(opened.initialResult.directive.action.kind, "wait");
  assert.equal(calls.length, 1);
  const sent = calls[0]!;
  assert.equal(sent.protocol_version, "1");
  assert.equal(sent.kind, "open_root_reconciler");
  assert.equal("payload" in sent, false);
  assert.equal(sent.root_issue_id, "root-1");
  assert.equal(sent.performer_profile_id, "profile-1");
  const root = ((sent.bootstrap as Record<string, unknown>).root_snapshot as Record<string, unknown>).root as Record<string, unknown>;
  const convergence = root.convergence as Record<string, unknown>;
  assert.equal((convergence.policy as Record<string, unknown>).max_cycles_per_root, 3);
  assert.equal((convergence.view as Record<string, unknown>).active_cycle_repair_attempts, 0);
  assert.deepEqual((sent.bootstrap as Record<string, unknown>).source_manifest, [{
    source_kind: "issue",
    source_id: "root-1",
    source_version_or_digest: "root-v1",
    actor_kind: "human",
  }]);
});

test("agent client decodes a closed Root Reconciler failure without retaining a session", async () => {
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId }) => ({
      protocol_version: "1",
      request_id: requestId,
      kind: "root_reconciler_opened",
      reconciler_session_id: "session-1",
      bootstrap_root_digest: "tree-1",
      initial_result: rootFailure(requestId, "turn-1", "tree-1"),
    })),
    deadlineMs: 30_000,
  });

  const opened = await client.openRootReconciler(openInput());

  assert.equal(opened.initialResult.kind, "failed");
  if (opened.initialResult.kind === "failed") {
    assert.equal(opened.initialResult.failure.failureId, "root-1:turn-1:failure");
    assert.equal(opened.initialResult.failure.modelTurn.outcome, "schema_invalid");
  }
  await assert.rejects(
    () => client.advanceRootReconciler({
      requestId: "advance-request",
      sessionId: "session-1",
      reconcilerTurnId: "turn-2",
      observedAt: "2026-07-23T00:00:02Z",
      delta: { baseRootDigest: "tree-1", targetRootDigest: "tree-2", changes: [], pendingInputIds: [] },
    }),
    /root_reconciler_session_profile_unknown/u,
  );
});

test("agent client discards a session after an advance returns a closed Root failure", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => body.kind === "open_root_reconciler"
      ? {
        protocol_version: "1",
        request_id: requestId,
        kind: "root_reconciler_opened",
        reconciler_session_id: "session-1",
        bootstrap_root_digest: "tree-1",
        initial_result: rootDirective(),
      }
      : rootFailure(requestId, "turn-2", "tree-2"), calls),
    deadlineMs: 30_000,
  });

  await client.openRootReconciler(openInput());
  const result = await client.advanceRootReconciler({
    requestId: "advance-request-1",
    sessionId: "session-1",
    reconcilerTurnId: "turn-2",
    observedAt: "2026-07-23T00:00:02Z",
    delta: { baseRootDigest: "tree-1", targetRootDigest: "tree-2", changes: [], pendingInputIds: [] },
  });

  assert.equal(result.kind, "failed");
  await assert.rejects(
    () => client.advanceRootReconciler({
      requestId: "advance-request-2",
      sessionId: "session-1",
      reconcilerTurnId: "turn-3",
      observedAt: "2026-07-23T00:00:03Z",
      delta: { baseRootDigest: "tree-2", targetRootDigest: "tree-3", changes: [], pendingInputIds: [] },
    }),
    /root_reconciler_session_profile_unknown/u,
  );
  assert.equal(calls.length, 2);
});

test("agent client carries native Plan Issue and convergence facts in Root bootstrap and delta wires", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => body.kind === "open_root_reconciler"
      ? {
        protocol_version: "1", request_id: requestId, kind: "root_reconciler_opened",
        reconciler_session_id: "session-1", bootstrap_root_digest: "tree-1", initial_result: waitDirective(requestId, "tree-1", "turn-1"),
      }
      : waitDirective(requestId, "tree-2", "advance-turn"), calls),
    deadlineMs: 30_000,
  });
  const input = openInput();
  const facts = planFacts();
  input.bootstrap.rootSnapshot.cycles = [facts.cycle];
  input.bootstrap.rootSnapshot.issues.push(facts.cycle.cycleIssue, ...facts.cycle.issues);

  await client.openRootReconciler(input);
  const bootstrap = calls[0]!.bootstrap as {
    root_snapshot: { cycles: Array<Record<string, unknown>> };
  };
  const cycle = bootstrap.root_snapshot.cycles[0]!;
  const plan = (cycle.issues as Array<Record<string, unknown>>)[0]!;
  assert.equal(plan.issue_kind, "plan");
  assert.equal(plan.status, "In Review");
  assert.match(String(plan.description), /Persist the complete Plan as native Linear facts/u);

  await client.advanceRootReconciler({
    requestId: "advance-request",
    sessionId: "session-1",
    reconcilerTurnId: "advance-turn",
    observedAt: "2026-07-23T00:00:01Z",
    delta: {
      baseRootDigest: "tree-1",
      targetRootDigest: "tree-2",
      changes: [
        {
          kind: "replacement", sourceKind: "issue", sourceId: "plan-1", sourceVersionOrDigest: "plan-v2",
          replacesSourceVersionOrDigest: "plan-v1",
          actorKind: "symphony", observedAt: "2026-07-23T00:00:01Z",
          value: { kind: "issue", issue: { ...facts.cycle.issues[0]!, status: "Approved", remoteVersion: "plan-v2" } },
        },
        {
          kind: "replacement", sourceKind: "mechanical_violation", sourceId: "root-1",
          sourceVersionOrDigest: "convergence-v2", replacesSourceVersionOrDigest: "convergence-v1",
          actorKind: "symphony", observedAt: "2026-07-23T00:00:01Z",
          value: {
            kind: "mechanical_violation", mechanicalViolations: [],
            convergence: {
              ...input.bootstrap.rootSnapshot.root.convergence,
              view: {
                ...input.bootstrap.rootSnapshot.root.convergence.view,
                activeCycleIssueId: "cycle-1",
                activeCycleRepairAttempts: 1,
              },
            },
          },
        },
      ],
      pendingInputIds: [],
    },
  });
  const delta = calls[1]!.delta as { changes: Array<Record<string, unknown>> };
  assert.equal("root_snapshot" in delta, false);
  assert.deepEqual(delta.changes.map(({ kind }) => kind), [
    "replacement",
    "replacement",
  ]);
  assert.equal(((delta.changes[0]!.value as Record<string, unknown>).issue as Record<string, unknown>).status, "Approved");
  assert.equal(
    (((((delta.changes[1]!.value as Record<string, unknown>).convergence as Record<string, unknown>).view as Record<string, unknown>)).active_cycle_repair_attempts),
    1,
  );
});

test("agent client reuses one Profile channel for a Root session lifecycle", async () => {
  let openedChannels = 0;
  const requestKinds: string[] = [];
  const closeReasons: string[] = [];
  const channelFactory: PerformerAgentChannelFactory = {
    open() {
      openedChannels += 1;
      return {
        async request({ requestId, body }) {
          requestKinds.push(String(body.kind));
          if (body.kind === "close_root_reconciler") closeReasons.push(String(body.reason));
          return (body.kind === "open_root_reconciler"
            ? {
              protocol_version: "1", request_id: requestId, kind: "root_reconciler_opened",
              reconciler_session_id: "session-1",
              bootstrap_root_digest: "tree-1", initial_result: rootDirective(),
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
  await client.openRootReconciler(openInput("open-request"));
  await client.closeRootReconciler({
    requestId: "close-request",
    rootIssueId: "root-1",
    sessionId: "session-1",
    reason: "root_terminal",
  });
  assert.equal(openedChannels, 1);
  assert.deepEqual(requestKinds, ["open_root_reconciler", "close_root_reconciler"]);
  assert.deepEqual(closeReasons, ["root_terminal"]);
});

test("agent client decodes direct role-specific results", async () => {
  const channelFactory = channelFactoryFor(({ requestId, body }) => {
    const role = body.role as "plan" | "work" | "verify";
    if (role === "plan") decodeConductorPerformerPlanTurnRequest(body as JsonValue);
    if (role === "work") decodeConductorPerformerWorkTurnRequest(body as JsonValue);
    if (role === "verify") decodeConductorPerformerVerifyTurnRequest(body as JsonValue);
    return directStageResult(role, requestId, body.context_digest as string) as JsonValue;
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

test("agent client preserves every validated completed Plan field", async () => {
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => {
      decodeConductorPerformerPlanTurnRequest(body as JsonValue);
      return completedPlanResult(requestId, body.context_digest as string) as JsonValue;
    }),
    deadlineMs: 30_000,
  });

  const result = await client.executePlanTurn(stageInput("plan"));

  assert.deepEqual(result.outcome, {
    kind: "plan_completed",
    planContract: {
      objective: "Persist the complete Plan Contract.",
      includedScope: ["apps/conductor"],
      excludedScope: [],
      assumptions: [],
      constraints: ["Use durable Linear facts."],
      acceptanceCriteria: [{
        criterionKey: "contract-persisted",
        statement: "The complete Plan Contract is stored before review.",
        verificationMethod: "Read the Plan Contract record.",
      }],
      verificationRequirements: ["npm test -w @symphony/conductor"],
    },
    proposedWorkDag: {
      workNodes: [{
        proposalKey: "persist-contract",
        title: "Persist the Plan Contract",
        description: "Write the canonical Plan Contract record.",
        expectedOutcome: "The contract can be reconstructed after restart.",
        requiredChecks: ["managed-record-read-back"],
        dependencyProposalKeys: [],
      }],
      dependencyEdges: [],
      verifyNode: {
        title: "Verify Plan Contract persistence",
        acceptanceCriteria: [{
          criterionKey: "contract-read-back",
          statement: "The stored contract matches the Plan result.",
          verificationMethod: "Read the Plan Contract record.",
        }],
        requiredChecks: ["managed-record-read-back"],
      },
    },
    risks: [],
    requiredPermissions: [],
    evidenceRefs: [],
  });
});

test("agent client preserves every validated Verify Finding field", async () => {
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => {
      decodeConductorPerformerVerifyTurnRequest(body as JsonValue);
      return changesRequiredResult(requestId, body.context_digest as string) as JsonValue;
    }),
    deadlineMs: 30_000,
  });

  const result = await client.executeVerifyTurn(stageInput("verify"));

  assert.deepEqual(result.outcome, {
    kind: "verify_changes_required",
    verifiedRevision: "head-1",
    conclusion: "changes_required",
    findings: [{
      findingId: "finding-1",
      category: "code",
      severity: "high",
      description: "Null input crashes the parser.",
      evidenceRefs: [{ referenceId: "parser-regression", sourceKind: "check" }],
      relatedWorkIssueIds: ["work-1"],
    }],
  });
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
      return directStageResult(role, requestId, body.context_digest as string) as JsonValue;
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
  assert.deepEqual(requests[0]!.model_settings, {
    model: "gpt",
    reasoning_effort: "medium",
    is_fast_mode_enabled: false,
  });
  assert.equal(requests.every((request) => !("context" in request)), true);
  const updates = requests.map((request) => request.role_context_update as {
    kind: string;
    sources: Array<{ value: { kind: string } }>;
  });
  assert.deepEqual(updates.map(({ kind }) => kind), ["initial", "initial", "initial"]);
  assert.deepEqual(updates[0]!.sources.map(({ value }) => value.kind).sort(), ["cycle", "git", "issue", "root_contract"]);
  assert.deepEqual(updates[1]!.sources.map(({ value }) => value.kind).sort(), ["git", "issue", "issue"]);
  assert.deepEqual(updates[2]!.sources.map(({ value }) => value.kind).sort(), ["git", "issue", "issue"]);
});

test("agent client isolates Stage baselines, sends only changed delta sources, and fresh-opens after closure", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ body }) => {
      if (body.role === "plan") decodeConductorPerformerPlanTurnRequest(body as JsonValue);
      else decodeConductorPerformerWorkTurnRequest(body as JsonValue);
      return directStageResultForRequest(body, body.request_id === "plan-closed") as JsonValue;
    }, calls),
    deadlineMs: 30_000,
  });

  await client.executePlanTurn(stageInput("plan"));
  const changed = stageInput("plan");
  changed.requestId = "plan-request-2";
  changed.roleTurnId = "plan-turn-2";
  const changedPlan = changed.tree.issues.find(({ issue_id }) => issue_id === "plan-1")!;
  changedPlan.description = "Revised Plan description";
  changedPlan.remote_version = "plan-v2";
  await client.executePlanTurn(changed);

  const work = stageInput("work");
  await client.executeWorkTurn(work);

  const closed = structuredClone(changed);
  closed.requestId = "plan-closed";
  closed.roleTurnId = "plan-turn-3";
  await client.executePlanTurn(closed);

  const fresh = structuredClone(changed);
  fresh.requestId = "plan-fresh";
  fresh.roleTurnId = "plan-turn-4";
  await client.executePlanTurn(fresh);

  assert.equal(calls.every((request) => !("context" in request)), true);
  const updates = calls.map((request) => request.role_context_update as {
    kind: string;
    changes?: Array<{ kind: string; source_id: string; replaces_source_version_or_digest?: string }>;
  });
  assert.deepEqual(updates.map(({ kind }) => kind), ["initial", "delta", "initial", "delta", "initial"]);
  assert.equal(updates[1]!.changes!.length, 1);
  assert.equal(updates[1]!.changes![0]!.kind, "replacement");
  assert.equal(updates[1]!.changes![0]!.source_id, "plan-1");
  assert.equal(updates[1]!.changes![0]!.replaces_source_version_or_digest, "plan-v1");
  assert.notEqual(calls[0]!.context_digest, calls[2]!.context_digest);
});

test("agent client keeps a long Work execution goal within the Plan Contract scope bound", async () => {
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => {
      decodeConductorPerformerWorkTurnRequest(body as JsonValue);
      return directStageResult("work", requestId, body.context_digest as string) as JsonValue;
    }),
    deadlineMs: 30_000,
  });

  await client.executeWorkTurn(stageInput("work", `execute work ${"x".repeat(512)}`));
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

  await assert.rejects(client.executePlanTurn(stageInput("plan")), /unknown field|expected exactly one union variant|stage_result|plan_result_response_contract_invalid/u);
});

test("agent client normalizes the Root directive wire fields", async () => {
  const client = new SessionPerformerAgentClientImpl({
    executable: "performer",
    environment: () => ({}),
    channelFactory: channelFactoryFor(({ requestId, body }) => body.kind === "open_root_reconciler"
      ? {
        protocol_version: "1", request_id: requestId, kind: "root_reconciler_opened",
        reconciler_session_id: "session-1", bootstrap_root_digest: "tree-1", initial_result: rootDirective(),
      }
      : {
        protocol_version: "1", request_id: requestId, root_directive_id: "directive-1",
        reconciler_session_id: "session-1", reconciler_turn_id: "turn-1", based_on_target_root_digest: "tree-1",
        model_turn: rootModelTurn("turn-1"),
        rationale: "execute the plan", evidence_refs: [], consumed_input_ids: [], comment_replies: [],
        action: {
          kind: "execute_plan", cycle_issue_id: "cycle-1", plan_issue_id: "plan-1", plan_goal: "plan",
          required_outputs: [], prior_plan_result_ids: [], human_resolution_ids: [],
        },
      } as JsonValue),
    deadlineMs: 30_000,
  });
  await client.openRootReconciler(openInput("open-request"));

  const result = await client.advanceRootReconciler({
    requestId: "advance-request",
    sessionId: "session-1",
    reconcilerTurnId: "advance-turn",
    observedAt: "2026-07-23T00:00:01Z",
    delta: { baseRootDigest: "tree-1", targetRootDigest: "tree-2", changes: [], pendingInputIds: [] },
  });

  assert.equal(result.kind, "directive");
  if (result.kind === "directive") {
    assert.equal(result.directive.action.kind, "execute_plan");
    if (result.directive.action.kind === "execute_plan") {
      assert.equal(result.directive.action.planIssueId, "plan-1");
      assert.equal(result.directive.action.cycleIssueId, "cycle-1");
    }
  }
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
