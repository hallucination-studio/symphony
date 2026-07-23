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
type JsonRecord = { [key: string]: JsonValue };

export interface SessionPerformerAgentClientOptions {
  executable: string;
  environment(profileId: string): NodeJS.ProcessEnv;
  lane: SerializedPerformerProcessRunnerInterface;
  deadlineMs: number | (() => number);
}

export class SessionPerformerAgentClientImpl implements PerformerAgentClientInterface {
  constructor(private readonly options: SessionPerformerAgentClientOptions) {}

  openRootReconciler(input: RootReconcilerOpenInput): Promise<RootReconcilerOpenResult> {
    return this.invoke(input.requestId, input.profileId, "open_root_reconciler", input)
      .then((response) => {
        const payload = record(response.payload);
        if (response.kind !== "root_reconciler_opened" || typeof payload.session_id !== "string") {
          throw new Error("root_reconciler_open_result_invalid");
        }
        return { kind: "opened", sessionId: payload.session_id };
      });
  }

  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    observation: RootReconciliationObservation;
  }): Promise<RootReconcilerAdvanceResult> {
    return this.invoke(input.requestId, input.observation.root.issueId, "advance_root_reconciler", input)
      .then((response) => {
        const payload = record(response.payload);
        if (response.kind !== "root_directive") throw new Error("root_reconciler_directive_missing");
        return { kind: "directive", directive: decodeDirective(payload.directive) };
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
    await this.invoke(input.requestId, input.rootIssueId, "close_cycle_stage_sessions", input);
  }

  async closeRootReconciler(input: { requestId: string; sessionId: string }): Promise<void> {
    await this.invoke(input.requestId, input.sessionId, "close_root_reconciler", input);
  }

  async cancelAndReap(): Promise<void> {
    await this.options.lane.cancelAndReap(1_000);
  }

  private async executeStage(kind: "execute_plan_turn" | "execute_work_turn" | "execute_verify_turn", input: StageTurnInput): Promise<StageResult> {
    const response = await this.invoke(input.requestId, input.profileId, kind, input);
    const payload = record(response.payload);
    if (response.kind !== "stage_result") throw new Error("stage_result_missing");
    return decodeStageResult(payload.result);
  }

  private async invoke(requestId: string, profileId: string, kind: string, payload: unknown): Promise<JsonRecord> {
    const body = JSON.stringify({ protocol_version: 1, request_id: requestId, kind, payload });
    const output = await this.options.lane.run({
      executable: this.options.executable,
      arguments: ["--agent"],
      environment: this.options.environment(profileId),
      deadlineMs: typeof this.options.deadlineMs === "function" ? this.options.deadlineMs() : this.options.deadlineMs,
      stdin: Buffer.from(`${body}\n`, "utf8"),
    });
    const line = output.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!line) throw new Error("performer_agent_response_missing");
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("performer_agent_response_invalid"); }
    const response = record(value);
    if (response.protocol_version !== 1 || response.request_id !== requestId) throw new Error("performer_agent_correlation_invalid");
    if (response.kind === "error") throw new Error(sanitizedError(response.payload));
    return response;
  }
}

function decodeDirective(value: JsonValue | undefined): RootDirective {
  const directive = record(value);
  const action = record(directive.action);
  if (directive.protocol_version !== 1 || typeof directive.root_directive_id !== "string" || typeof directive.based_on_root_tree_digest !== "string") {
    throw new Error("root_directive_shape_invalid");
  }
  if (typeof action.kind !== "string" || !new Set([
    "execute_plan", "execute_work", "execute_verify", "rerun_stage", "resolve_invalid_lifecycle",
    "revise_cycle_tree", "replan_current_cycle", "supersede_cycle", "create_successor_cycle",
    "request_human_action", "conclude_cycle", "conclude_root", "wait", "acknowledge",
  ]).has(action.kind)) throw new Error("root_directive_action_invalid");
  return directive as unknown as RootDirective;
}

function decodeStageResult(value: JsonValue | undefined): StageResult {
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

function sanitizedError(value: JsonValue | undefined): string {
  const payload = record(value);
  return (typeof payload.sanitized_reason === "string" ? payload.sanitized_reason : "performer_agent_failed")
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .slice(0, 2_000);
}
