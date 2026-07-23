import type { SerializedPerformerProcessRunnerInterface } from "../../performer-profiles/internal/SerializedPerformerProcessRunnerImpl.js";
import type {
  PerformerAgentClientInterface,
} from "../api/PerformerAgentClientInterface.js";
import type {
  RootDirective,
  RootReconcilerAdvanceResult,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
  RootReconciliationObservation,
  StageResult,
  StageTurnInput,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, unknown>;

export interface SessionPerformerAgentClientOptions {
  executable: string;
  environment(profileId: string): NodeJS.ProcessEnv;
  lane: SerializedPerformerProcessRunnerInterface;
  deadlineMs: number | (() => number);
}

export class SessionPerformerAgentClientImpl implements PerformerAgentClientInterface {
  constructor(private readonly options: SessionPerformerAgentClientOptions) {}

  openRootReconciler(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult> {
    return this.invoke(input.requestId, input.profileId, {
      protocol_version: "1",
      request_id: input.requestId,
      kind: "open_root_reconciler",
      root_issue_id: input.rootIssueId,
      performer_profile_id: input.profileId,
      model_settings: {
        model: input.modelSettings.model,
        reasoning_effort: input.modelSettings.reasoningEffort,
        is_fast_mode_enabled: input.modelSettings.isFastModeEnabled,
      },
      execution_policy: {
        sandbox_mode: "read_only",
        allowed_tools: [],
        denied_tools: [],
        network_policy: "disabled",
      },
      limits: defaultLimits(this.options.deadlineMs),
    })
      .then((response) => {
        if (response.kind !== "root_reconciler_opened" || typeof response.reconciler_session_id !== "string") {
          throw new Error("root_reconciler_open_result_invalid");
        }
        return { kind: "opened", sessionId: response.reconciler_session_id };
      });
  }

  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    observation: RootReconciliationObservation;
  }): Promise<RootReconcilerAdvanceResult> {
    const observation = input.observation;
    return this.invoke(input.requestId, observation.root.issueId, {
      protocol_version: "1",
      request_id: input.requestId,
      kind: "advance_root_reconciler",
      role_session_id: input.sessionId,
      role_turn_id: observation.reconcilerTurnId,
      root_issue_id: observation.root.issueId,
      observed_root_tree_digest: observation.treeDigest,
      observation: toWireObservation(observation),
    })
      .then((response) => {
        if (response.kind !== "root_directive") throw new Error("root_reconciler_directive_missing");
        return { kind: "directive", directive: decodeDirective(response.directive) };
      });
  }

  executePlanTurn(input: StageTurnInput): Promise<StageResult> {
    return this.executeStage("execute_plan_turn", input);
  }

  executeWorkTurn(input: StageTurnInput): Promise<StageResult> {
    return this.executeStage("execute_work_turn", input);
  }

  executeVerifyTurn(input: StageTurnInput): Promise<StageResult> {
    return this.executeStage("execute_verify_turn", input);
  }

  async closeCycleStageSessions(input: { requestId: string; rootIssueId: string; cycleIssueId: string }): Promise<void> {
    await this.invoke(input.requestId, input.rootIssueId, {
      protocol_version: "1", request_id: input.requestId, kind: "close_cycle_stage_sessions",
      root_issue_id: input.rootIssueId, cycle_issue_id: input.cycleIssueId, reason: "cycle_terminal",
    });
  }

  async closeRootReconciler(input: { requestId: string; rootIssueId: string; sessionId: string }): Promise<void> {
    await this.invoke(input.requestId, input.sessionId, {
      protocol_version: "1", request_id: input.requestId, kind: "close_root_reconciler",
      root_issue_id: input.rootIssueId, reason: "root_terminal",
    });
  }

  async cancelAndReap(): Promise<void> {
    await this.options.lane.cancelAndReap(1_000);
  }

  private async executeStage(kind: "execute_plan_turn" | "execute_work_turn" | "execute_verify_turn", input: StageTurnInput): Promise<StageResult> {
    const response = await this.invoke(input.requestId, input.profileId, {
      protocol_version: "1", request_id: input.requestId, kind, ...toWireStageInput(input),
    });
    if (response.kind !== "stage_result") throw new Error("stage_result_missing");
    return decodeStageResult(response.result);
  }

  private async invoke(requestId: string, profileId: string, body: JsonRecord): Promise<JsonRecord> {
    const output = await this.options.lane.run({
      executable: this.options.executable,
      arguments: ["--agent"],
      environment: this.options.environment(profileId),
      deadlineMs: typeof this.options.deadlineMs === "function" ? this.options.deadlineMs() : this.options.deadlineMs,
      stdin: Buffer.from(`${JSON.stringify(body)}\n`, "utf8"),
    });
    const line = output.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!line) throw new Error("performer_agent_response_missing");
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("performer_agent_response_invalid"); }
    const response = record(value);
    if (response.protocol_version !== "1" || response.request_id !== requestId) throw new Error("performer_agent_correlation_invalid");
    if (response.kind === "error") throw new Error(sanitizedError(response));
    return response;
  }
}

function defaultLimits(deadlineMs: number | (() => number)) {
  const duration = typeof deadlineMs === "function" ? deadlineMs() : deadlineMs;
  return {
    max_context_bytes: 8_388_608,
    max_result_bytes: 1_048_576,
    max_output_tokens: 32_768,
    max_tool_calls: 0,
    max_wall_time_ms: Math.max(1_000, Math.min(86_400_000, duration)),
    deadline_at: new Date(Date.now() + duration).toISOString(),
  };
}

function toWireObservation(input: RootReconciliationObservation): JsonRecord {
  return {
    protocol_version: "1",
    request_id: input.requestId,
    reconciler_session_id: input.reconcilerSessionId,
    reconciler_turn_id: input.reconcilerTurnId,
    observed_at: input.observedAt,
    root: input.root,
    cycles: input.cycles,
    root_human_actions: [],
    accepted_root_directives: input.acceptedDirectives,
    root_reconciler_failures: input.rootReconcilerFailures,
    pending_user_comments: input.pendingUserComments,
    reconciler_reply_records: input.reconcilerReplies,
    external_linear_changes: input.externalLinearChanges,
    workflow_change_resolutions: [],
    git_facts: input.git,
    delivery: { record_id: "none", record_kind: "none", version: "none" },
    source_manifest: [],
    coverage: { is_complete: input.complete, omissions: [] },
    observed_root_tree_digest: input.treeDigest,
    limits: defaultLimits(input.limits.maxTurnWallTimeMs),
  };
}

function toWireStageInput(input: StageTurnInput): JsonRecord {
  return {
    stage_execution_id: input.stageExecutionId,
    role: input.role,
    role_session_id: input.roleSessionId,
    role_turn_id: input.roleTurnId,
    root_issue_id: input.rootIssueId,
    cycle_issue_id: input.cycleIssueId,
    target_issue_id: input.targetIssueId,
    observed_tree_digest: input.observedTreeDigest,
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    instruction_bundle: {
      instruction_set_id: "symphony-stage-v1",
      instructions: input.goal,
      output_schema: "stage_result",
    },
    repository_context: {
      repository_identity: input.rootIssueId,
      base_branch: input.git.branch,
      workspace_revision: input.git.head,
      baseline_revision: input.git.head,
      status_summary: input.git.status.items.join("\n"),
      relevant_paths: input.git.status.items,
      workspace_access: input.executionPolicy.workspace_access,
      instructions: [],
    },
    execution_policy: {
      sandbox_mode: input.executionPolicy.sandbox_mode,
      allowed_tools: [],
      denied_tools: [],
      network_policy: "disabled",
    },
    limits: defaultLimits(300_000),
    context_digest: input.contextDigest,
    context: input,
  };
}

function decodeDirective(value: unknown): RootDirective {
  const directive = record(value);
  const action = record(directive.action);
  if (directive.protocol_version !== "1" || typeof directive.root_directive_id !== "string" || typeof directive.based_on_root_tree_digest !== "string") {
    throw new Error("root_directive_shape_invalid");
  }
  if (typeof action.kind !== "string" || !new Set([
    "execute_plan", "execute_work", "execute_verify", "rerun_stage", "resolve_invalid_lifecycle",
    "revise_cycle_tree", "replan_current_cycle", "supersede_cycle", "create_successor_cycle",
    "request_human_action", "conclude_cycle", "conclude_root", "wait", "acknowledge",
  ]).has(action.kind)) throw new Error("root_directive_action_invalid");
  return directive as unknown as RootDirective;
}

function decodeStageResult(value: unknown): StageResult {
  const result = record(value);
  const outcome = record(result.outcome);
  if (typeof result.stage_execution_id !== "string" || typeof result.role !== "string" || typeof outcome.kind !== "string") {
    throw new Error("stage_result_shape_invalid");
  }
  return {
    ...result,
    resultId: result.stage_execution_id,
    protocolVersion: 1,
    rootIssueId: result.root_issue_id,
    cycleIssueId: result.cycle_issue_id,
    targetIssueId: result.target_issue_id,
    roleSessionId: result.role_session_id,
    roleTurnId: result.role_turn_id,
    stageExecutionId: result.stage_execution_id,
    observedTreeDigest: result.observed_tree_digest,
    contextDigest: result.context_digest,
    completedAt: result.completed_at,
    outcome,
  } as unknown as StageResult;
}

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_response_object_invalid");
  return value as JsonRecord;
}

function sanitizedError(value: unknown): string {
  const payload = record(value);
  return (typeof payload.sanitized_reason === "string" ? payload.sanitized_reason : "performer_agent_failed")
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .slice(0, 2_000);
}
