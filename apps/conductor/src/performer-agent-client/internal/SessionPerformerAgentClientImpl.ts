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
  RootBootstrap,
  RootDelta,
  RootDeltaChange,
  RootDirective,
  RootReconcilerAdvanceResult,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
  RootTree,
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
      reconciler_session_id: input.reconcilerSessionId,
      reconciler_turn_id: input.reconcilerTurnId,
      observed_at: input.observedAt,
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
      bootstrap: toWireBootstrap(input.bootstrap),
      limits: toWireLimits(input.limits),
    }, decodeConductorPerformerRootReconcilerOpenedResult, "root_reconciler_open_response_contract_invalid")
      .then((response) => {
        if (
          response.kind !== "root_reconciler_opened" ||
          typeof response.reconciler_session_id !== "string" ||
          typeof response.bootstrap_root_digest !== "string"
        ) {
          throw new Error("root_reconciler_open_result_invalid");
        }
        this.profileByRoot.set(input.rootIssueId, input.profileId);
        this.profileByRootSession.set(response.reconciler_session_id, input.profileId);
        return {
          kind: "opened",
          sessionId: response.reconciler_session_id,
          bootstrapRootDigest: response.bootstrap_root_digest,
          initialDirective: decodeDirective(response.initial_directive),
        };
      });
  }

  advanceRootReconciler(input: {
    requestId: string;
    sessionId: string;
    reconcilerTurnId: string;
    observedAt: string;
    delta: RootDelta;
  }): Promise<RootReconcilerAdvanceResult> {
    const profileId = this.profileByRootSession.get(input.sessionId);
    if (!profileId) return Promise.reject(new Error("root_reconciler_session_profile_unknown"));
    return this.invoke(
      input.requestId,
      profileId,
      {
        protocol_version: "1",
        request_id: input.requestId,
        kind: "advance_root_reconciler",
        reconciler_session_id: input.sessionId,
        reconciler_turn_id: input.reconcilerTurnId,
        observed_at: input.observedAt,
        delta: toWireDelta(input.delta),
        limits: defaultLimits(this.options.deadlineMs),
      },
      decodeConductorPerformerRootDirective,
      "root_directive_response_contract_invalid",
    )
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
    }, decodeConductorPerformerCloseCycleStageSessionsResult, "cycle_stage_close_response_contract_invalid");
  }

  async closeRootReconciler(input: { requestId: string; rootIssueId: string; sessionId: string }): Promise<void> {
    const profileId = this.profileByRootSession.get(input.sessionId);
    if (!profileId) throw new Error("root_reconciler_session_profile_unknown");
    await this.invoke(input.requestId, profileId, {
      protocol_version: "1", request_id: input.requestId, kind: "close_root_reconciler",
      root_issue_id: input.rootIssueId, reason: "root_terminal",
    }, decodeConductorPerformerCloseRootReconcilerResult, "root_reconciler_close_response_contract_invalid");
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
    const responseContractCode = kind === "execute_plan_turn"
      ? "plan_result_response_contract_invalid"
      : kind === "execute_work_turn"
        ? "work_result_response_contract_invalid"
        : "verify_result_response_contract_invalid";
    const response = await this.invoke(input.requestId, input.profileId, {
      protocol_version: "1", request_id: input.requestId, ...toWireStageInput(input),
    }, decoder, responseContractCode);
    try {
      return decodeStageResult(response);
    } catch (error) {
      const wrapped = new Error("stage_result_normalization_invalid", { cause: error });
      Object.assign(wrapped, { code: "stage_result_normalization_invalid" });
      throw wrapped;
    }
  }

  private async invoke(
    requestId: string,
    profileId: string,
    body: JsonRecord,
    decoder: (value: JsonValue) => JsonValue,
    responseContractCode: string,
  ): Promise<JsonRecord> {
    try {
      const value = await this.channelFor(profileId).request({
        requestId,
        body,
        deadlineMs: typeof this.options.deadlineMs === "function" ? this.options.deadlineMs() : this.options.deadlineMs,
      });
      const response = record(value);
      if (response.protocol_version !== "1" || response.request_id !== requestId) throw new Error("performer_agent_correlation_invalid");
      if (response.kind === "error") throw new Error(sanitizedError(response));
      try {
        return record(decoder(value as JsonValue));
      } catch (error) {
        const wrapped = new Error(responseContractCode, { cause: error });
        Object.assign(wrapped, { code: responseContractCode });
        throw wrapped;
      }
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

function toWireLimits(limits: import("../../root-reconciliation/api/RootReconciliationContracts.js").ReconcilerLimits): JsonRecord {
  return {
    max_context_bytes: limits.maxContextBytes,
    max_result_bytes: limits.maxResultBytes,
    max_output_tokens: limits.maxOutputTokens,
    max_tool_calls: limits.maxToolCalls,
    max_wall_time_ms: limits.maxWallTimeMs,
    deadline_at: limits.deadlineAt,
  };
}

function toWireBootstrap(input: RootBootstrap): JsonRecord {
  return {
    root_snapshot: {
      root: toWireRootObservation(input.rootSnapshot.root),
      cycles: input.rootSnapshot.cycles.map(toWireCycleObservation),
      issues: input.rootSnapshot.issues.map(toWireFactIssue),
      relations: input.rootSnapshot.relations.map(toWireRelation),
      managed_records: input.rootSnapshot.managedRecords.map(toWireRecordReference),
      user_comments: input.rootSnapshot.userComments.map(toWireComment),
      git_facts: toWireGitFacts(input.rootSnapshot.gitFacts),
      delivery: toWireRecordReference(input.rootSnapshot.delivery),
      mechanical_violations: input.rootSnapshot.mechanicalViolations.map(toWireMechanicalViolation),
    },
    source_manifest: input.sourceManifest.map((entry) => ({
      source_kind: entry.sourceKind,
      source_id: entry.sourceId,
      version_or_digest: entry.versionOrDigest,
    })),
    coverage: {
      is_complete: input.coverage.isComplete,
      omissions: input.coverage.omissions.map((omission) => ({ source_id: omission.sourceId, reason: omission.reason })),
    },
    root_digest: input.rootDigest,
    pending_input_ids: input.pendingInputIds,
  };
}

function toWireDelta(input: RootDelta): JsonRecord {
  return {
    base_root_digest: input.baseRootDigest,
    target_root_digest: input.targetRootDigest,
    changes: input.changes.map(toWireDeltaChange),
    pending_input_ids: input.pendingInputIds,
  };
}

function toWireDeltaChange(change: RootDeltaChange): JsonRecord {
  const base = {
    kind: change.kind,
    source_id: change.sourceId,
    source_version: change.sourceVersion,
    actor_kind: change.actorKind,
    observed_at: change.observedAt,
  };
  if (change.kind === "issue_current_value") return { ...base, issue: toWireFactIssue(change.issue) };
  if (change.kind === "comment_current_value") return { ...base, comment: toWireComment(change.comment) };
  if (change.kind === "relation_current_value") return { ...base, relation: toWireRelation(change.relation) };
  if (change.kind === "managed_record_current_value") return { ...base, record: toWireRecordReference(change.record) };
  if (change.kind === "plan_contract_current_value") {
    return { ...base, plan_issue_id: change.planIssueId, plan_contract: toWireCanonicalPlanContract(change.planContract) };
  }
  if (change.kind === "plan_completed_result_current_value") {
    return { ...base, plan_completed_result: toWirePlanCompletedResult(change.planCompletedResult) };
  }
  if (change.kind === "plan_contract_removed") {
    return {
      ...base,
      cycle_issue_id: change.cycleIssueId,
      plan_issue_id: change.planIssueId,
      plan_contract_digest: change.planContractDigest,
    };
  }
  if (change.kind === "plan_completed_result_removed") {
    return { ...base, cycle_issue_id: change.cycleIssueId, result_id: change.resultId };
  }
  if (change.kind === "git_facts_current_value") return { ...base, git_facts: toWireGitFacts(change.gitFacts) };
  if (change.kind === "mechanical_violations_current_value") {
    return { ...base, mechanical_violations: change.mechanicalViolations.map(toWireMechanicalViolation) };
  }
  return base;
}

function toWireRootObservation(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootObservation): JsonRecord {
  return {
    issue: toWireFactIssue(input.issue),
    objective: input.objective,
    scope: input.scope,
    acceptance_criteria: input.acceptanceCriteria.map((criterion) => ({
      criterion_key: criterion.criterionKey,
      statement: criterion.statement,
      verification_method: criterion.verificationMethod,
    })),
    constraints: input.constraints,
    root_status: input.rootStatus,
    ownership: toWireRecordReference(input.ownership),
    convergence_summary: input.convergenceSummary,
  };
}

function toWireCycleObservation(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootCycleObservation): JsonRecord {
  return {
    cycle_issue: toWireFactIssue(input.cycleIssue),
    predecessor_cycle_issue_id: input.predecessorCycleIssueId,
    cycle_status: input.cycleStatus,
    is_archived: input.isArchived,
    ...(input.activePlanContract ? { active_plan_contract: toWireCanonicalPlanContract(input.activePlanContract) } : {}),
    ...(input.budget ? { budget: toWireBudget(input.budget) } : {}),
    ...(input.outcome ? { outcome: toWireRecordReference(input.outcome) } : {}),
    issues: input.issues.map(toWireFactIssue),
    relations: input.relations.map(toWireRelation),
    plan_results: input.planResults.map(toWireRecordReference),
    plan_completed_results: input.planCompletedResults.map(toWirePlanCompletedResult),
    work_results: input.workResults.map(toWireRecordReference),
    verify_results: input.verifyResults.map(toWireRecordReference),
    findings: input.findings.map(toWireFinding),
    human_action_records: input.humanActionRecords.map(toWireHumanActionRecord),
    human_action_resolutions: input.humanActionResolutions.map(toWireHumanActionResolution),
  };
}

function toWireCanonicalPlanContract(input: import("../../root-reconciliation/api/ManagedRecords.js").PlanContract): JsonRecord {
  return {
    kind: input.kind,
    version: input.version,
    root_issue_id: input.rootIssueId,
    cycle_issue_id: input.cycleIssueId,
    plan_contract_digest: input.planContractDigest,
    ...toWirePlanContractProposal(input),
    proposed_work_dag: toWirePlanDag(input.proposedWorkDag),
  };
}

function toWirePlanCompletedResult(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootPlanCompletedResult): JsonRecord {
  return {
    result_id: input.resultId,
    root_issue_id: input.rootIssueId,
    cycle_issue_id: input.cycleIssueId,
    node_issue_id: input.nodeIssueId,
    summary: input.summary,
    completed_at: input.completedAt,
    plan_contract_digest: input.planContractDigest,
    plan_contract: toWirePlanContractProposal(input.planContract),
    proposed_work_dag: toWirePlanDag(input.proposedWorkDag),
    risks: input.risks,
    required_permissions: input.requiredPermissions,
    evidence_refs: input.evidenceRefs.map((reference) => ({ reference_id: reference.referenceId, source_kind: reference.sourceKind })),
  };
}

function toWirePlanContractProposal(input: import("../../root-reconciliation/api/ManagedRecords.js").PlanContractProposal): JsonRecord {
  return {
    objective: input.objective,
    included_scope: input.includedScope,
    excluded_scope: input.excludedScope,
    assumptions: input.assumptions,
    constraints: input.constraints,
    acceptance_criteria: input.acceptanceCriteria.map((criterion) => ({
      criterion_key: criterion.criterionKey,
      statement: criterion.statement,
      verification_method: criterion.verificationMethod,
    })),
    verification_requirements: input.verificationRequirements,
  };
}

function toWirePlanDag(input: import("../../root-reconciliation/api/ManagedRecords.js").ProposedWorkDag): JsonRecord {
  return {
    work_nodes: input.workNodes.map((work) => ({
      proposal_key: work.proposalKey,
      title: work.title,
      description: work.description,
      expected_outcome: work.expectedOutcome,
      required_checks: work.requiredChecks,
      dependency_proposal_keys: work.dependencyProposalKeys,
    })),
    dependency_edges: input.dependencyEdges.map((relation) => ({
      relation_id: relation.relationId,
      relation_kind: relation.relationKind,
      source_issue_id: relation.sourceIssueId,
      target_issue_id: relation.targetIssueId,
    })),
    verify_node: {
      title: input.verifyNode.title,
      acceptance_criteria: input.verifyNode.acceptanceCriteria.map((criterion) => ({
        criterion_key: criterion.criterionKey,
        statement: criterion.statement,
        verification_method: criterion.verificationMethod,
      })),
      required_checks: input.verifyNode.requiredChecks,
    },
  };
}

function toWireHumanActionRecord(record: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootHumanActionRecord): JsonRecord {
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

function toWireHumanActionResolution(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").HumanActionResolution): JsonRecord {
  return {
    resolution_id: input.resolutionId,
    action_id: input.actionId,
    action_issue_id: input.actionIssueId,
    ...(input.actionKind ? { action_kind: input.actionKind } : {}),
    outcome: input.outcome,
    terminal_status: input.terminalStatus,
    terminal_remote_version: input.terminalRemoteVersion,
    proposal_digest: input.proposalDigest,
    ...(input.sourceCommentIds ? { source_comment_ids: input.sourceCommentIds } : {}),
    actor_kind: input.actorKind,
    resolved_at: input.resolvedAt,
  };
}

function toWireRecordReference(reference: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootRecordReference): JsonRecord {
  return {
    record_id: reference.recordId, record_kind: reference.recordKind, version: reference.version,
  };
}

function toWireComment(comment: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootFactComment): JsonRecord {
  return {
    comment_id: comment.commentId,
    comment_version: comment.commentVersion,
    issue_id: comment.issueId,
    ...(comment.authorUserId ? { author_user_id: comment.authorUserId } : {}),
    author_kind: comment.authorKind,
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    ...(comment.managedMarker ? { managed_marker: comment.managedMarker } : {}),
  };
}

function toWireRelation(relation: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootFactRelation): JsonRecord {
  return {
    relation_id: relation.relationId,
    relation_kind: relation.relationKind,
    source_issue_id: relation.sourceIssueId,
    target_issue_id: relation.targetIssueId,
  };
}

function toWireGitFacts(facts: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootGitFacts): JsonRecord {
  return {
    head_revision: facts.headRevision,
    baseline_revision: facts.baselineRevision,
    status_summary: facts.statusSummary,
    changed_paths: facts.changedPaths,
  };
}

function toWireMechanicalViolation(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").MechanicalViolation): JsonRecord {
  return { violation_kind: input.violationKind, source_issue_ids: input.sourceIssueIds, summary: input.summary };
}

function toWireFinding(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootFinding): JsonRecord {
  return { finding_id: input.findingId, category: input.category, severity: input.severity, summary: input.summary };
}

function toWireBudget(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootBudgetSnapshot): JsonRecord {
  return { turns_used: input.turnsUsed, turns_remaining: input.turnsRemaining, tokens_used: input.tokensUsed, tokens_remaining: input.tokensRemaining };
}

function toWireStageInput(input: StageTurnInput): JsonRecord {
  const rootIssue = input.tree.issues.find((issue) => issue.issue_id === input.rootIssueId);
  const cycleIssue = input.tree.issues.find((issue) => issue.issue_id === input.cycleIssueId);
  const targetIssue = input.tree.issues.find((issue) => issue.issue_id === input.targetIssueId);
  if (!rootIssue || !cycleIssue || !targetIssue) throw new Error("stage_context_issue_missing");
  const rootContract = planRootContract(rootIssue);
  const planContract = planContractFor(input, rootIssue, targetIssue);
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

function toWireIssue(issue: RootTree["issues"][number]): JsonRecord {
  const issueKind = issue.issue_kind ?? "work";
  return {
    issue_id: issue.issue_id,
    issue_kind: issueKind === "human" ? "human_action" : issueKind,
    ...(issue.parent_issue_id ? { parent_issue_id: issue.parent_issue_id } : {}),
    title: issue.title,
    description: issue.description,
    status: issue.status_name,
    is_archived: issue.is_archived,
    labels: issue.labels,
    remote_version: issue.remote_version,
  };
}

function toWireFactIssue(issue: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootFactIssue): JsonRecord {
  return {
    issue_id: issue.issueId,
    issue_kind: issue.issueKind,
    ...(issue.parentIssueId ? { parent_issue_id: issue.parentIssueId } : {}),
    title: issue.title,
    description: issue.description,
    status: issue.status,
    is_archived: issue.isArchived,
    labels: issue.labels,
    remote_version: issue.remoteVersion,
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

function planContractFor(input: StageTurnInput, rootIssue: JsonRecord, targetIssue: JsonRecord): JsonRecord {
  const objective = typeof rootIssue.description === "string" && rootIssue.description
    ? rootIssue.description
    : input.goal;
  return {
    objective,
    included_scope: [scopeSummary(input.goal, targetIssue.title)],
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

function scopeSummary(goal: string, title: unknown): string {
  if (goal.trim().length > 0 && goal.length <= 256) return goal;
  if (typeof title === "string" && title.trim().length > 0 && title.length <= 256) return title;
  return "selected work issue";
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
  if (directive.protocol_version !== "1" || typeof directive.root_directive_id !== "string" || typeof directive.based_on_target_root_digest !== "string") {
    throw new Error("root_directive_shape_invalid");
  }
  if (typeof action.kind !== "string" || !new Set([
    "execute_plan", "execute_work", "execute_verify", "rerun_stage", "revise_root_tree",
    "replan_current_cycle", "supersede_cycle", "create_cycle", "request_human_action",
    "conclude_cycle", "conclude_root", "cancel_root", "wait", "acknowledge",
  ]).has(action.kind)) throw new Error("root_directive_action_invalid");
  return camelizeKeys(directive) as RootDirective;
}

function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      camelizeKeys(child),
    ]),
  );
}

function decodeStageResult(value: unknown): StageResult {
  const result = record(value);
  const outcome = record(result.outcome);
  if (typeof result.stage_execution_id !== "string" || typeof result.role !== "string" || typeof outcome.kind !== "string") {
    throw new Error("role_result_shape_invalid");
  }
  const normalizedOutcome = normalizeStageResultOutcome(outcome);
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

function normalizeStageResultOutcome(outcome: JsonRecord): StageResult["outcome"] {
  const kind = outcome.kind;
  if (typeof kind !== "string") throw new Error("role_result_outcome_invalid");
  if (kind === "plan_completed") {
    const planContract = record(outcome.plan_contract);
    const proposedWorkDag = record(outcome.proposed_work_dag);
    const risks = stringArray(outcome.risks, "role_result_plan_risks_invalid");
    const requiredPermissions = stringArray(outcome.required_permissions, "role_result_plan_permissions_invalid");
    const evidenceRefs = evidenceReferences(outcome.evidence_refs);
    return {
      kind,
      planContract: camelizeKeys(planContract) as NonNullable<StageResult["outcome"]["planContract"]>,
      proposedWorkDag: camelizeKeys(proposedWorkDag) as NonNullable<StageResult["outcome"]["proposedWorkDag"]>,
      risks,
      requiredPermissions,
      evidenceRefs,
    };
  }
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

function evidenceReferences(value: unknown): NonNullable<StageResult["outcome"]["evidenceRefs"]> {
  if (!Array.isArray(value)) throw new Error("role_result_plan_evidence_invalid");
  return value.map((entry) => {
    const reference = record(entry);
    const referenceId = string(reference.reference_id, "role_result_plan_evidence_invalid");
    const sourceKind = reference.source_kind;
    if (typeof sourceKind !== "string" || ![
      "linear_issue", "linear_comment", "linear_record", "git", "check", "result",
    ].includes(sourceKind)) {
      throw new Error("role_result_plan_evidence_invalid");
    }
    return { referenceId, sourceKind: sourceKind as NonNullable<StageResult["outcome"]["evidenceRefs"]>[number]["sourceKind"] };
  });
}

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("agent_response_object_invalid");
  return value as JsonRecord;
}

function sanitizedError(value: unknown): string {
  const payload = record(value);
  if (typeof payload.code === "string" && /^[a-z][a-z0-9_:-]{1,120}$/u.test(payload.code)) {
    return payload.code;
  }
  return (typeof payload.sanitized_reason === "string" ? payload.sanitized_reason : "performer_agent_failed")
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/giu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .slice(0, 2_000);
}
