import {
  decodeConductorPerformerCloseCycleStageSessionsResult,
  decodeConductorPerformerCloseRootReconcilerResult,
  decodeConductorPerformerPlanResult,
  decodeConductorPerformerRootDirective,
  decodeConductorPerformerRootReconcilerOpenedResult,
  decodeConductorPerformerVerifyResult,
  decodeConductorPerformerWorkResult,
  type JsonValue,
} from "@symphony/contracts";
import type { PerformerAgentChannel, PerformerAgentChannelFactory } from "./PerformerAgentChannel.js";
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

type JsonRecord = Record<string, unknown>;

export interface SessionPerformerAgentClientOptions {
  executable: string;
  environment(profileId: string): NodeJS.ProcessEnv;
  channelFactory: PerformerAgentChannelFactory;
  deadlineMs: number | (() => number);
}

export class SessionPerformerAgentClientImpl implements PerformerAgentClientInterface {
  private readonly channels = new Map<string, PerformerAgentChannel>();
  private readonly profileByRoot = new Map<string, string>();
  private readonly profileByRootSession = new Map<string, string>();

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
    }, decodeConductorPerformerRootReconcilerOpenedResult)
      .then((response) => {
        if (response.kind !== "root_reconciler_opened" || typeof response.reconciler_session_id !== "string") {
          throw new Error("root_reconciler_open_result_invalid");
        }
        this.profileByRoot.set(input.rootIssueId, input.profileId);
        this.profileByRootSession.set(response.reconciler_session_id, input.profileId);
        return { kind: "opened", sessionId: response.reconciler_session_id };
      });
  }

  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    observation: RootReconciliationObservation;
  }): Promise<RootReconcilerAdvanceResult> {
    const observation = input.observation;
    const profileId = this.profileByRootSession.get(input.sessionId);
    if (!profileId) return Promise.reject(new Error("root_reconciler_session_profile_unknown"));
    return this.invoke(input.requestId, profileId, toWireObservation(observation), decodeConductorPerformerRootDirective)
      .then((response) => {
        return { kind: "directive", directive: decodeDirective(response) };
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
    const profileId = this.profileByRoot.get(input.rootIssueId);
    if (!profileId) return;
    await this.invoke(input.requestId, profileId, {
      protocol_version: "1", request_id: input.requestId, kind: "close_cycle_stage_sessions",
      root_issue_id: input.rootIssueId, cycle_issue_id: input.cycleIssueId, reason: "cycle_terminal",
    }, decodeConductorPerformerCloseCycleStageSessionsResult);
  }

  async closeRootReconciler(input: { requestId: string; rootIssueId: string; sessionId: string }): Promise<void> {
    const profileId = this.profileByRootSession.get(input.sessionId);
    if (!profileId) throw new Error("root_reconciler_session_profile_unknown");
    await this.invoke(input.requestId, profileId, {
      protocol_version: "1", request_id: input.requestId, kind: "close_root_reconciler",
      root_issue_id: input.rootIssueId, reason: "root_terminal",
    }, decodeConductorPerformerCloseRootReconcilerResult);
    this.profileByRootSession.delete(input.sessionId);
    this.profileByRoot.delete(input.rootIssueId);
  }

  async cancelAndReap(): Promise<void> {
    const channels = [...this.channels.values()];
    this.channels.clear();
    await Promise.all(channels.map((channel) => channel.close(1_000)));
  }

  private async executeStage(kind: "execute_plan_turn" | "execute_work_turn" | "execute_verify_turn", input: StageTurnInput): Promise<StageResult> {
    this.profileByRoot.set(input.rootIssueId, input.profileId);
    const decoder = kind === "execute_plan_turn"
      ? decodeConductorPerformerPlanResult
      : kind === "execute_work_turn"
        ? decodeConductorPerformerWorkResult
        : decodeConductorPerformerVerifyResult;
    const response = await this.invoke(input.requestId, input.profileId, {
      protocol_version: "1", request_id: input.requestId, ...toWireStageInput(input),
    }, decoder);
    return decodeStageResult(response);
  }

  private async invoke(requestId: string, profileId: string, body: JsonRecord, decoder: (value: JsonValue) => JsonValue): Promise<JsonRecord> {
    try {
      const value = await this.channelFor(profileId).request({
        requestId,
        body,
        deadlineMs: typeof this.options.deadlineMs === "function" ? this.options.deadlineMs() : this.options.deadlineMs,
      });
      const response = record(value);
      if (response.protocol_version !== "1" || response.request_id !== requestId) throw new Error("performer_agent_correlation_invalid");
      if (response.kind === "error") throw new Error(sanitizedError(response));
      return record(decoder(value as JsonValue));
    } catch (error) {
      this.dropProfile(profileId);
      throw error;
    }
  }

  private channelFor(profileId: string): PerformerAgentChannel {
    const existing = this.channels.get(profileId);
    if (existing) return existing;
    const channel = this.options.channelFactory.open({
      executable: this.options.executable,
      environment: this.options.environment(profileId),
    });
    this.channels.set(profileId, channel);
    return channel;
  }

  private dropProfile(profileId: string): void {
    this.channels.delete(profileId);
    for (const [rootIssueId, mappedProfileId] of this.profileByRoot) {
      if (mappedProfileId === profileId) this.profileByRoot.delete(rootIssueId);
    }
    for (const [sessionId, mappedProfileId] of this.profileByRootSession) {
      if (mappedProfileId === profileId) this.profileByRootSession.delete(sessionId);
    }
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
  const rootIssue = input.tree.issues.find((issue) => issue.issue_id === input.root.issueId);
  if (!rootIssue) throw new Error("root_observation_root_issue_missing");
  const objective = input.root.description || input.root.title;
  return {
    protocol_version: "1",
    request_id: input.requestId,
    reconciler_session_id: input.reconcilerSessionId,
    reconciler_turn_id: input.reconcilerTurnId,
    observed_at: input.observedAt,
    root: {
      issue: toWireIssue(rootIssue, "root"),
      objective,
      scope: input.root.title,
      acceptance_criteria: [{
        criterion_key: `${input.root.issueId}:objective`,
        statement: objective,
        verification_method: "provider-defined verification",
      }],
      constraints: [],
      root_status: rootIssue.status_name,
      ownership: { record_id: input.root.issueId, record_kind: "root_ownership", version: rootIssue.remote_version },
      convergence_summary: "Root convergence is governed by durable Linear and Git facts.",
    },
    cycles: input.cycles.map((cycle) => ({
      cycle_issue: toWireIssue(cycle.cycleIssue, "cycle"),
      predecessor_cycle_issue_id: cycle.cycleIssue.parent_issue_id ?? "none",
      cycle_status: cycle.cycleIssue.status_name,
      is_archived: cycle.isArchived,
      issues: cycle.issues.map((issue) => toWireIssue(issue)),
      relations: cycle.relations,
      plan_results: cycle.planResults.map(toWireRecordReference),
      work_results: cycle.workResults.map(toWireRecordReference),
      verify_results: cycle.verifyResults.map(toWireRecordReference),
      findings: [],
      human_action_records: cycle.humanActionRecords.map(toWireHumanActionRecord),
      human_action_resolutions: [],
    })),
    root_human_actions: input.rootHumanActions.map(toWireHumanActionRecord),
    accepted_root_directives: input.acceptedDirectives.map((directive) => ({
      record_id: directive.rootDirectiveId,
      record_kind: "accepted_root_directive",
      version: directive.basedOnRootTreeDigest,
    })),
    root_reconciler_failures: input.rootReconcilerFailures.map((failure) => ({
      failure_id: failure.failureId,
      reconciler_session_id: failure.reconcilerSessionId,
      reconciler_turn_id: failure.reconcilerTurnId,
      observed_root_tree_digest: failure.observedRootTreeDigest,
      category: failure.category,
      sanitized_reason: failure.sanitizedReason,
      failed_at: failure.failedAt,
    })),
    pending_user_comments: input.pendingUserComments.map((comment) => ({
      comment_id: comment.commentId,
      comment_version: comment.commentVersion,
      issue_id: comment.issueId,
      issue_kind: comment.issueKind === "human" ? "human_action" : comment.issueKind,
      ...(comment.cycleIssueId ? { cycle_issue_id: comment.cycleIssueId } : {}),
      author_user_id: comment.authorUserId,
      body: comment.body,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    })),
    reconciler_reply_records: input.reconcilerReplies.map((reply) => ({
      reply_id: reply.replyId,
      root_directive_id: reply.rootDirectiveId,
      source_comment_id: reply.sourceCommentId,
      source_comment_version: reply.sourceCommentVersion,
      target_issue_id: reply.targetIssueId,
      materialized_outcome_refs: reply.materializedOutcomeRefs.map((referenceId) => ({ reference_id: referenceId, source_kind: "result" })),
      rendered_schema_version: "1",
      replied_at: reply.repliedAt,
    })),
    external_linear_changes: input.externalLinearChanges.map((change) => ({
      change_id: change.changeId,
      actor_kind: change.actorKind,
      target_issue_id: change.targetIssueId,
      issue_kind: change.issueKind === "human" ? "human_action" : change.issueKind,
      change_kind: change.changeKind,
      before_version_or_digest: change.beforeVersionOrDigest,
      after_version_or_digest: change.afterVersionOrDigest,
      changed_field_names: change.changedFieldNames,
      relation_ids: change.relationIds,
      observed_at: change.observedAt,
    })),
    workflow_change_resolutions: [],
    git_facts: {
      head_revision: input.git.head,
      baseline_revision: input.git.head,
      status_summary: input.git.status.items.join("\n") || "clean",
      changed_paths: input.git.status.items,
    },
    delivery: { record_id: "none", record_kind: "none", version: "none" },
    source_manifest: [],
    coverage: { is_complete: input.complete, omissions: [] },
    observed_root_tree_digest: input.treeDigest,
    limits: defaultLimits(input.limits.maxTurnWallTimeMs),
  };
}

function toWireHumanActionRecord(record: RootReconciliationObservation["rootHumanActions"][number]): JsonRecord {
  return {
    action_id: record.actionId,
    action_issue_id: record.actionIssueId,
    action_kind: record.actionKind,
    parent_scope: record.parentScope,
    ...(record.cycleIssueId ? { cycle_issue_id: record.cycleIssueId } : {}),
    status: record.status,
    is_archived: record.isArchived,
    related_issue_ids: record.relatedIssueIds,
  };
}

function toWireRecordReference(reference: RootReconciliationObservation["cycles"][number]["planResults"][number]): JsonRecord {
  return {
    record_id: reference.recordId,
    record_kind: reference.recordKind,
    version: reference.version,
  };
}

function toWireStageInput(input: StageTurnInput): JsonRecord {
  const rootIssue = input.tree.issues.find((issue) => issue.issue_id === input.rootIssueId);
  const cycleIssue = input.tree.issues.find((issue) => issue.issue_id === input.cycleIssueId);
  const targetIssue = input.tree.issues.find((issue) => issue.issue_id === input.targetIssueId);
  if (!rootIssue || !cycleIssue || !targetIssue) throw new Error("stage_context_issue_missing");
  const rootContract = planRootContract(rootIssue);
  const planContract = planContractFor(input, rootIssue);
  const planDag = planDagFor(input);
  const gitFacts = gitFactsFor(input);
  const context = input.role === "plan"
    ? {
      root_contract: rootContract,
      cycle: { cycle_issue_id: cycleIssue.issue_id, trigger: "initial" },
      current_plan_issue: toWireIssue(targetIssue),
      prior_plan_results: [],
      prior_plan_contracts: [],
      unresolved_findings: [],
      human_resolutions: [],
      current_git_facts: gitFacts,
      required_output: input.goal,
    }
    : input.role === "work"
      ? {
        approved_plan_contract: planContract,
        current_active_work_dag: planDag,
        selected_work: toWireIssue(targetIssue),
        completed_work_evidence: [],
        prior_turn_results: [],
        human_resolutions: [],
        git_baseline: gitFacts,
        workspace_capability: "workspace_write",
      }
      : {
        approved_plan_contract: planContract,
        complete_active_cycle_dag: planDag,
        archived_cycle_nodes: input.tree.issues.filter((issue) => issue.is_archived).map((issue) => toWireIssue(issue)),
        completed_work_results: [],
        unresolved_findings: [],
        human_resolutions: [],
        verification_requirements: input.requiredEvidenceRefs.length > 0 ? input.requiredEvidenceRefs : ["provider-defined verification"],
        immutable_target_revision: input.git.head,
        repository_snapshot: gitFacts,
      };
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
      output_schema: `${input.role}_result`,
    },
    repository_context: {
      repository_identity: input.rootIssueId,
      base_branch: input.git.branch,
      workspace_revision: input.git.head,
      baseline_revision: input.git.head,
      status_summary: input.git.status.items.join("\n") || "clean",
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
    context,
  };
}

function toWireIssue(issue: RootReconciliationObservation["tree"]["issues"][number], fallbackKind?: "root" | "cycle"): JsonRecord {
  return {
    issue_id: issue.issue_id,
    issue_kind: issue.issue_kind ?? fallbackKind ?? "work",
    ...(issue.parent_issue_id ? { parent_issue_id: issue.parent_issue_id } : {}),
    title: issue.title,
    description: issue.description,
    status: issue.status_name,
    is_archived: issue.is_archived,
    remote_version: issue.remote_version,
  };
}

function gitFactsFor(input: StageTurnInput): JsonRecord {
  return {
    head_revision: input.git.head,
    baseline_revision: input.git.head,
    status_summary: input.git.status.items.join("\n") || "clean",
    changed_paths: input.git.status.items,
  };
}

function planRootContract(rootIssue: JsonRecord): JsonRecord {
  const objective = typeof rootIssue.description === "string" && rootIssue.description
    ? rootIssue.description
    : String(rootIssue.title);
  return {
    objective,
    requested_scope: String(rootIssue.title),
    constraints: [],
    acceptance_criteria: [{
      criterion_key: `${String(rootIssue.issue_id)}:objective`,
      statement: objective,
      verification_method: "provider-defined verification",
    }],
  };
}

function planContractFor(input: StageTurnInput, rootIssue: JsonRecord): JsonRecord {
  const objective = typeof rootIssue.description === "string" && rootIssue.description
    ? rootIssue.description
    : input.goal;
  return {
    objective,
    included_scope: [input.goal],
    excluded_scope: [],
    assumptions: [],
    constraints: [],
    acceptance_criteria: [{
      criterion_key: `${input.targetIssueId}:acceptance`,
      statement: objective,
      verification_method: "provider-defined verification",
    }],
    verification_requirements: input.requiredEvidenceRefs.length > 0 ? input.requiredEvidenceRefs : ["provider-defined verification"],
  };
}

function planDagFor(input: StageTurnInput): JsonRecord {
  const workIssues = input.tree.issues.filter((issue) => issue.issue_kind === "work" && !issue.is_archived);
  const fallback = input.tree.issues.find((issue) => issue.issue_id === input.targetIssueId);
  if (!fallback) throw new Error("stage_context_target_issue_missing");
  const selected = workIssues.length > 0 ? workIssues : [fallback];
  const workNodes = selected.filter(Boolean).map((issue) => ({
    proposal_key: issue.issue_id,
    title: issue.title,
    description: issue.description,
    expected_outcome: issue.description || issue.title,
    required_checks: ["provider-defined verification"],
    dependency_proposal_keys: input.tree.relations
      .filter((relation) => relation.target_issue_id === issue.issue_id && relation.relation_kind === "blocks")
      .map((relation) => relation.source_issue_id),
  }));
  return {
    work_nodes: workNodes,
    dependency_edges: input.tree.relations,
    verify_node: {
      title: "Verify cycle",
      acceptance_criteria: [{
        criterion_key: `${input.cycleIssueId}:verify`,
        statement: "The cycle objective is complete.",
        verification_method: "provider-defined verification",
      }],
      required_checks: ["provider-defined verification"],
    },
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
    throw new Error("role_result_shape_invalid");
  }
  const normalizedOutcome = normalizeStageOutcome(outcome);
  return {
    resultId: result.stage_execution_id,
    protocolVersion: 1,
    rootIssueId: result.root_issue_id,
    cycleIssueId: result.cycle_issue_id,
    targetIssueId: result.target_issue_id,
    role: result.role as StageResult["role"],
    roleSessionId: result.role_session_id,
    roleTurnId: result.role_turn_id,
    stageExecutionId: result.stage_execution_id,
    observedTreeDigest: result.observed_tree_digest,
    contextDigest: result.context_digest,
    summary: stageResultSummary(outcome),
    sourceManifest: [],
    completedAt: result.completed_at,
    outcome: normalizedOutcome,
  } as StageResult;
}

function normalizeStageOutcome(outcome: JsonRecord): StageResult["outcome"] {
  const kind = outcome.kind;
  if (typeof kind !== "string") throw new Error("role_result_outcome_invalid");
  if (kind === "work_completed") {
    const changes = record(outcome.actual_changes);
    return {
      kind,
      changedPaths: stringArray(changes.changed_paths, "role_result_changed_paths_invalid"),
      commitRevision: string(changes.target_revision, "role_result_target_revision_invalid"),
    };
  }
  if (kind === "verify_passed" || kind === "verify_changes_required" || kind === "verify_inconclusive" || kind === "verify_plan_contract_violation" || kind === "verify_blocked") {
    const targetRevision = outcome.target_revision;
    return {
      kind,
      ...(typeof targetRevision === "string" ? { verifiedRevision: targetRevision } : {}),
      ...(kind === "verify_passed" ? { conclusion: "passed" as const } : {}),
      ...(kind === "verify_changes_required" ? { conclusion: "changes_required" as const } : {}),
      ...(kind === "verify_inconclusive" ? { conclusion: "inconclusive" as const } : {}),
    };
  }
  if (kind === "execution_failed") {
    return { kind, errorCode: string(outcome.error_code, "role_result_error_code_invalid") };
  }
  return { kind };
}

function stageResultSummary(outcome: JsonRecord): string {
  for (const key of ["summary", "sanitized_reason", "impact"]) {
    if (typeof outcome[key] === "string" && outcome[key]) return outcome[key] as string;
  }
  const changes = outcome.actual_changes;
  if (changes && typeof changes === "object" && !Array.isArray(changes) && typeof (changes as JsonRecord).summary === "string") {
    return (changes as JsonRecord).summary as string;
  }
  return typeof outcome.kind === "string" ? outcome.kind : "stage_result";
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function stringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(code);
  return value as string[];
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
