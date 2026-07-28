import {
  decodeConductorPerformerCloseCycleStageSessionsResult,
  decodeConductorPerformerCloseRootReconcilerResult,
  decodeConductorPerformerPlanResult,
  decodeConductorPerformerRootReconcilerOpenedResult,
  decodeConductorPerformerRootReconcilerTurnResult,
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
  RootReconcilerTurnResult,
  RootReconcilerOpenInput,
  RootReconcilerOpenResult,
  RootTree,
  StageResult,
  StageTurnInput,
} from "../../root-reconciliation/api/RootReconciliationContracts.js";

type JsonRecord = Record<string, unknown>;
type StageSource = JsonRecord & {
  source_kind: string;
  source_id: string;
  source_version_or_digest: string;
  actor_kind: string;
  observed_at: string;
  value: JsonRecord;
};
interface StageContextBatch {
  update: JsonRecord;
  sources: Map<string, StageSource>;
  manifest: JsonRecord[];
  digest: string;
}

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
  private readonly stageBaselines = new Map<string, {
    profileId: string;
    role: string;
    rootIssueId: string;
    cycleIssueId: string;
    digest: string;
    sources: Map<string, StageSource>;
  }>();

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
        const initialResult = decodeRootTurnResult(response.initial_result);
        if (initialResult.kind === "directive" || initialResult.failure.continuity.kind === "retained") {
          this.profileByRoot.set(input.rootIssueId, input.profileId);
          this.profileByRootSession.set(response.reconciler_session_id, input.profileId);
        }
        return {
          kind: "opened",
          sessionId: response.reconciler_session_id,
          bootstrapRootDigest: response.bootstrap_root_digest,
          initialResult,
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
      decodeConductorPerformerRootReconcilerTurnResult,
      "root_reconciler_turn_response_contract_invalid",
    )
      .then((response) => {
        const result = decodeRootTurnResult(response);
        if (result.kind === "failed" && result.failure.continuity.kind === "closed") {
          this.profileByRootSession.delete(input.sessionId);
        }
        return result;
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
    for (const [sessionId, baseline] of this.stageBaselines) {
      if (baseline.rootIssueId === input.rootIssueId && baseline.cycleIssueId === input.cycleIssueId) {
        this.stageBaselines.delete(sessionId);
      }
    }
  }

  async closeRootReconciler(input: {
    requestId: string;
    rootIssueId: string;
    sessionId: string;
    reason: "root_terminal" | "turn_failed";
  }): Promise<void> {
    const profileId = this.profileByRootSession.get(input.sessionId);
    if (!profileId) throw new Error("root_reconciler_session_profile_unknown");
    await this.invoke(input.requestId, profileId, {
      protocol_version: "1", request_id: input.requestId, kind: "close_root_reconciler",
      root_issue_id: input.rootIssueId, reason: input.reason,
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
    const previous = this.stageBaselines.get(input.roleSessionId);
    if (previous && (previous.profileId !== input.profileId || previous.role !== input.role)) {
      throw new Error("stage_role_session_correlation_invalid");
    }
    const batch = buildStageContextBatch(input, previous);
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
      protocol_version: "1", request_id: input.requestId, ...toWireStageInput(input, batch),
    }, decoder, responseContractCode);
    try {
      const result = decodeStageResult(response);
      if (result.contextDigest !== batch.digest) throw new Error("stage_context_digest_mismatch");
      const continuity = result.outcome.continuity;
      if (result.outcome.kind !== "execution_failed" || continuity?.kind === "retained" && continuity.appendOutcome === "accepted") {
        this.stageBaselines.set(input.roleSessionId, {
          profileId: input.profileId,
          role: input.role,
          rootIssueId: input.rootIssueId,
          cycleIssueId: input.cycleIssueId,
          digest: batch.digest,
          sources: batch.sources,
        });
      } else if (continuity?.kind === "closed") {
        this.stageBaselines.delete(input.roleSessionId);
      }
      return result;
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
    for (const [sessionId, baseline] of this.stageBaselines) {
      if (baseline.profileId === profileId) this.stageBaselines.delete(sessionId);
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

function buildStageContextBatch(
  input: StageTurnInput,
  previous: { digest: string; sources: Map<string, StageSource> } | undefined,
): StageContextBatch {
  const sources = stageSources(input);
  const digest = canonicalDigest([...sources.values()].map((source) => [
    source.source_kind, source.source_id, source.source_version_or_digest, source.actor_kind,
  ]));
  const manifest = [...sources.values()].map((source) => ({
    source_kind: source.source_kind,
    source_id: source.source_id,
    version_or_digest: source.source_version_or_digest,
    actor_kind: source.actor_kind,
  }));
  if (!previous) {
    return {
      update: { kind: "initial", target_context_digest: digest, sources: [...sources.values()] },
      sources,
      manifest,
      digest,
    };
  }
  const changes: JsonRecord[] = [];
  const keys = new Set([...previous.sources.keys(), ...sources.keys()]);
  for (const key of [...keys].sort()) {
    const before = previous.sources.get(key);
    const after = sources.get(key);
    if (before && after && canonicalDigest(before) === canonicalDigest(after)) continue;
    if (after && before) {
      changes.push({ ...after, kind: "replacement", replaces_source_version_or_digest: before.source_version_or_digest });
    } else if (after) {
      changes.push(after);
    } else if (before) {
      changes.push({
        kind: "tombstone",
        source_kind: before.source_kind,
        source_id: before.source_id,
        source_version_or_digest: canonicalDigest({ removed: before.source_version_or_digest, target: digest }),
        removes_source_version_or_digest: before.source_version_or_digest,
        actor_kind: "unknown",
        observed_at: input.tree.observed_at,
        reason: "left_role_scope",
      });
    }
  }
  return {
    update: {
      kind: "delta",
      base_context_digest: previous.digest,
      target_context_digest: digest,
      changes,
    },
    sources,
    manifest,
    digest,
  };
}

function stageSources(input: StageTurnInput): Map<string, StageSource> {
  const root = input.tree.issues.find(({ issue_id }) => issue_id === input.rootIssueId);
  const cycle = input.tree.issues.find(({ issue_id }) => issue_id === input.cycleIssueId);
  if (!root || !cycle) throw new Error("stage_context_issue_missing");
  const manifest = new Map(input.tree.source_manifest.map((source) => [
    `${source.source_kind}:${source.source_id}`,
    source,
  ]));
  const relevantIds = new Set<string>([input.targetIssueId]);
  if (input.role !== "plan") {
    relevantIds.add(input.cycleIssueId);
    for (const issue of input.tree.issues) {
      if (belongsToCycle(issue.issue_id, input.cycleIssueId, input.tree)) relevantIds.add(issue.issue_id);
    }
  } else {
    for (const issue of input.tree.issues) {
      if (belongsToCycle(issue.issue_id, input.cycleIssueId, input.tree) &&
          (issue.issue_kind === "plan" || issue.issue_kind === "finding")) relevantIds.add(issue.issue_id);
    }
  }
  const values: StageSource[] = [];
  if (input.role === "plan") {
    values.push(stageSource("linear_issue", root.issue_id, root.remote_version, root.updated_at, "unknown", {
      kind: "root_contract",
      root_contract: planRootContract(root),
    }));
    values.push(stageSource("linear_issue", cycle.issue_id, cycle.remote_version, cycle.updated_at, "unknown", {
      kind: "cycle",
      cycle: { cycle_issue_id: cycle.issue_id, trigger: "initial" },
    }));
  }
  for (const issue of input.tree.issues.filter(({ issue_id }) => relevantIds.has(issue_id))) {
    if (input.role === "plan" && (issue.issue_id === root.issue_id || issue.issue_id === cycle.issue_id)) continue;
    const source = manifest.get(`linear_issue:${issue.issue_id}`);
    values.push(stageSource("linear_issue", issue.issue_id, source?.source_version ?? issue.remote_version,
      issue.updated_at, source?.actor_kind ?? "unknown", { kind: "issue", issue: toWireIssue(issue) }));
  }
  for (const comment of input.tree.comments.filter(({ issue_id }) => relevantIds.has(issue_id))) {
    const source = manifest.get(`linear_comment:${comment.comment_id}`);
    values.push(stageSource("linear_comment", comment.comment_id, source?.source_version ?? comment.remote_version,
      comment.updated_at, source?.actor_kind ?? comment.author_kind, { kind: "comment", comment: toWireTreeComment(comment) }));
  }
  for (const relation of input.tree.relations.filter(({ source_issue_id, target_issue_id }) =>
    relevantIds.has(source_issue_id) && relevantIds.has(target_issue_id))) {
    const source = manifest.get(`linear_relation:${relation.relation_id}`);
    values.push(stageSource("linear_relation", relation.relation_id,
      source?.source_version ?? canonicalDigest(relation), input.tree.observed_at, source?.actor_kind ?? "unknown",
      { kind: "relation", relation: toWireTreeRelation(relation) }));
  }
  values.push(stageSource("git", `git:${input.rootIssueId}`, canonicalDigest(input.git), input.tree.observed_at,
    "symphony", { kind: "git", git_facts: gitFactsFor(input) }));
  values.sort((left, right) => `${left.source_kind}:${left.source_id}`.localeCompare(`${right.source_kind}:${right.source_id}`));
  return new Map(values.map((source) => [`${source.source_kind}:${source.source_id}`, source]));
}

function stageSource(
  sourceKind: string,
  sourceId: string,
  sourceVersionOrDigest: string,
  observedAt: string,
  actorKind: string,
  value: JsonRecord,
): StageSource {
  return {
    kind: "current_value",
    source_kind: sourceKind,
    source_id: sourceId,
    source_version_or_digest: sourceVersionOrDigest,
    actor_kind: actorKind,
    observed_at: observedAt,
    value,
  };
}

function belongsToCycle(issueId: string, cycleIssueId: string, tree: RootTree): boolean {
  let current = tree.issues.find(({ issue_id }) => issue_id === issueId);
  const visited = new Set<string>();
  while (current && !visited.has(current.issue_id)) {
    if (current.issue_id === cycleIssueId) return true;
    visited.add(current.issue_id);
    current = current.parent_issue_id
      ? tree.issues.find(({ issue_id }) => issue_id === current!.parent_issue_id)
      : undefined;
  }
  return false;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function toWireBootstrap(input: RootBootstrap): JsonRecord {
  return {
    root_snapshot: {
      root: toWireRootObservation(input.rootSnapshot.root),
      cycles: input.rootSnapshot.cycles.map(toWireCycleObservation),
      issues: input.rootSnapshot.issues.map(toWireFactIssue),
      relations: input.rootSnapshot.relations.map(toWireRelation),
      attachments: input.rootSnapshot.attachments.map(toWireAttachmentFact),
      activities: input.rootSnapshot.activities.map(toWireActivityFact),
      user_comments: input.rootSnapshot.userComments.map(toWireComment),
      user_comment_thread_states: input.rootSnapshot.userCommentThreadStates.map(toWireCommentThreadState),
      worktree_gate: toWireWorktreeGate(input.rootSnapshot.worktreeGate),
      mechanical_violations: input.rootSnapshot.mechanicalViolations.map(toWireMechanicalViolation),
    },
    source_manifest: input.sourceManifest.map((entry) => ({
      source_kind: entry.sourceKind,
      source_id: entry.sourceId,
      source_version_or_digest: entry.sourceVersionOrDigest,
      actor_kind: entry.actorKind,
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
    source_kind: change.sourceKind,
    source_id: change.sourceId,
    source_version_or_digest: change.sourceVersionOrDigest,
    actor_kind: change.actorKind,
    observed_at: change.observedAt,
  };
  if (change.kind === "tombstone") return {
    ...base,
    removes_source_version_or_digest: change.removesSourceVersionOrDigest,
    reason: change.reason,
  };
  return {
    ...base,
    ...(change.kind === "replacement"
      ? { replaces_source_version_or_digest: change.replacesSourceVersionOrDigest }
      : {}),
    value: toWireRootContextValue(change.value),
  };
}

function toWireRootContextValue(value: Exclude<RootDeltaChange, { kind: "tombstone" }>["value"]): JsonRecord {
  if (value.kind === "issue") return { kind: value.kind, issue: toWireFactIssue(value.issue) };
  if (value.kind === "comment") return { kind: value.kind, user_input: toWireUserCommentInput(value.userInput) };
  if (value.kind === "comment_thread") {
    return { kind: value.kind, thread_state: toWireCommentThreadState(value.threadState) };
  }
  if (value.kind === "activity") return { kind: value.kind, activity: toWireActivityFact(value.activity) };
  if (value.kind === "relation") return { kind: value.kind, relation: toWireRelation(value.relation) };
  if (value.kind === "attachment") return { kind: value.kind, attachment: toWireAttachmentFact(value.attachment) };
  if (value.kind === "git") return { kind: value.kind, worktree_gate: toWireWorktreeGate(value.worktreeGate) };
  return {
    kind: value.kind,
    mechanical_violations: value.mechanicalViolations.map(toWireMechanicalViolation),
    convergence: toWireRootConvergence(value.convergence),
  };
}

function toWireAttachmentFact(value: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootAttachmentFact): JsonRecord {
  return {
    attachment_id: value.attachmentId,
    issue_id: value.issueId,
    title: value.title,
    url: value.url,
    source_type: value.sourceType,
    remote_version: value.remoteVersion,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function toWireActivityFact(value: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootActivityFact): JsonRecord {
  return {
    activity_id: value.activityId,
    issue_id: value.issueId,
    activity_kinds: value.activityKinds,
    actor_kind: value.actorKind,
    ...(value.actorId === undefined ? {} : { actor_id: value.actorId }),
    ...(value.fromStateId === undefined ? {} : { from_state_id: value.fromStateId }),
    ...(value.toStateId === undefined ? {} : { to_state_id: value.toStateId }),
    ...(value.updatedDescription === undefined ? {} : { updated_description: value.updatedDescription }),
    ...(value.archived === undefined ? {} : { archived: value.archived }),
    ...(value.addedLabelIds === undefined ? {} : { added_label_ids: value.addedLabelIds }),
    ...(value.removedLabelIds === undefined ? {} : { removed_label_ids: value.removedLabelIds }),
    ...(value.fromParentId === undefined ? {} : { from_parent_id: value.fromParentId }),
    ...(value.toParentId === undefined ? {} : { to_parent_id: value.toParentId }),
    ...(value.fromDelegateId === undefined ? {} : { from_delegate_id: value.fromDelegateId }),
    ...(value.toDelegateId === undefined ? {} : { to_delegate_id: value.toDelegateId }),
    ...(value.attachmentId === undefined ? {} : { attachment_id: value.attachmentId }),
    remote_version: value.remoteVersion,
    created_at: value.createdAt,
  };
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
    convergence: toWireRootConvergence(input.convergence),
  };
}

function toWireWorktreeGate(
  input: import("../../git-workspaces/api/GitWorkspaceInterface.js").RootWorktreeGateResult,
): JsonRecord {
  switch (input.kind) {
    case "valid":
      return {
        kind: input.kind,
        repository_identity: input.repositoryIdentity,
        branch: input.branch,
        head_revision: input.headRevision,
        is_clean: input.isClean,
        changed_paths: input.changedPaths,
      };
    case "fresh_missing":
      return {
        kind: input.kind,
        repository_identity: input.repositoryIdentity,
        base_branch: input.baseBranch,
        base_revision: input.baseRevision,
      };
    case "recoverable_missing":
      return {
        kind: input.kind,
        repository_identity: input.repositoryIdentity,
        branch: input.branch,
        head_revision: input.headRevision,
      };
    case "execution_generation_invalid":
      return {
        kind: input.kind,
        repository_identity: input.repositoryIdentity,
        expected_branch: input.expectedBranch,
        reason: input.reason,
      };
  }
}

function toWireRootConvergence(
  input: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootConvergenceSnapshot,
): JsonRecord {
  return {
    policy: {
      max_cycles_per_root: input.policy.maxCyclesPerRoot,
      max_same_open_finding_cycles: input.policy.maxSameOpenFindingCycles,
      max_consecutive_no_progress: input.policy.maxConsecutiveNoProgress,
      max_cycle_repair_attempts: input.policy.maxCycleRepairAttempts,
      deadline_at: input.policy.deadlineAt,
    },
    view: {
      cycle_count: input.view.cycleCount,
      open_finding_persistence: input.view.openFindingPersistence.map((finding) => ({
        finding_id: finding.findingId,
        open_cycle_count: finding.openCycleCount,
      })),
      consecutive_no_progress: input.view.consecutiveNoProgress,
      ...(input.view.activeCycleIssueId ? { active_cycle_issue_id: input.view.activeCycleIssueId } : {}),
      active_cycle_repair_attempts: input.view.activeCycleRepairAttempts,
      is_deadline_exceeded: input.view.isDeadlineExceeded,
      root_is_canceled: input.view.rootIsCanceled,
    },
  };
}

function toWireCycleObservation(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootCycleObservation): JsonRecord {
  return {
    cycle_issue: toWireFactIssue(input.cycleIssue),
    cycle_status: input.cycleStatus,
    is_archived: input.isArchived,
    issues: input.issues.map(toWireFactIssue),
    relations: input.relations.map(toWireRelation),
  };
}

function toWireComment(comment: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootFactComment): JsonRecord {
  return {
    comment_id: comment.commentId,
    comment_remote_version: comment.commentRemoteVersion,
    issue_id: comment.issueId,
    author_id: comment.authorId,
    ...(comment.authorUserId ? { author_user_id: comment.authorUserId } : {}),
    author_kind: comment.authorKind,
    ...(comment.parentCommentId ? { parent_comment_id: comment.parentCommentId } : {}),
    thread_root_comment_id: comment.threadRootCommentId,
    thread_state: comment.threadState,
    reactions: comment.reactions.map((reaction) => ({
      reaction_id: reaction.reactionId,
      emoji: reaction.emoji,
      actor_kind: reaction.actorKind,
      actor_id: reaction.actorId,
    })),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function toWireCommentThreadState(
  state: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootCommentThreadState,
): JsonRecord {
  return {
    comment_id: state.commentId,
    comment_remote_version: state.commentRemoteVersion,
    thread_root_comment_id: state.threadRootCommentId,
    thread_state: state.threadState,
    actor_kind: state.actorKind,
    ...(state.resolvedAt ? { resolved_at: state.resolvedAt } : {}),
    observed_at: state.observedAt,
  };
}

function toWireUserCommentInput(
  input: import("../../root-reconciliation/api/RootReconciliationContracts.js").UserCommentInput,
): JsonRecord {
  if (input.kind === "comment_thread_state") {
    return {
      kind: input.kind,
      input_id: input.inputId,
      comment_id: input.commentId,
      comment_remote_version: input.commentRemoteVersion,
      thread_root_comment_id: input.threadRootCommentId,
      issue_id: input.issueId,
      issue_kind: input.issueKind,
      ...(input.cycleIssueId ? { cycle_issue_id: input.cycleIssueId } : {}),
      actor_kind: input.actorKind,
      thread_state: input.threadState,
      ...(input.resolvedAt ? { resolved_at: input.resolvedAt } : {}),
      observed_at: input.observedAt,
    };
  }
  return {
    kind: input.kind,
    input_id: input.inputId,
    comment_id: input.commentId,
    comment_body_digest: input.commentBodyDigest,
    issue_id: input.issueId,
    issue_kind: input.issueKind,
    ...(input.cycleIssueId ? { cycle_issue_id: input.cycleIssueId } : {}),
    author_kind: input.authorKind,
    author_id: input.authorId,
    ...(input.authorUserId ? { author_user_id: input.authorUserId } : {}),
    body: input.body,
    thread_root_comment_id: input.threadRootCommentId,
    thread_state: input.threadState,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
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

function toWireMechanicalViolation(input: import("../../root-reconciliation/api/RootReconciliationContracts.js").MechanicalViolation): JsonRecord {
  return { violation_kind: input.violationKind, source_issue_ids: input.sourceIssueIds, summary: input.summary };
}

function toWireStageInput(input: StageTurnInput, batch: StageContextBatch): JsonRecord {
  const rootIssue = input.tree.issues.find((issue) => issue.issue_id === input.rootIssueId);
  const cycleIssue = input.tree.issues.find((issue) => issue.issue_id === input.cycleIssueId);
  const targetIssue = input.tree.issues.find((issue) => issue.issue_id === input.targetIssueId);
  if (!rootIssue || !cycleIssue || !targetIssue) throw new Error("stage_context_issue_missing");
  return {
    stage_execution_id: input.stageExecutionId,
    role: input.role,
    role_session_id: input.roleSessionId,
    role_turn_id: input.roleTurnId,
    root_issue_id: input.rootIssueId,
    cycle_issue_id: input.cycleIssueId,
    target_issue_id: input.targetIssueId,
    observed_tree_digest: input.observedTreeDigest,
    source_manifest: batch.manifest,
    coverage: { is_complete: true, omissions: [] },
    instruction_bundle: {
      instruction_set_id: "symphony-stage-v1",
      instructions: input.goal,
      output_schema: `${input.role}_result`,
    },
    role_context_update: batch.update,
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
    model_settings: {
      model: input.modelSettings.model,
      reasoning_effort: input.modelSettings.reasoningEffort,
      is_fast_mode_enabled: input.modelSettings.isFastModeEnabled,
    },
    limits: defaultLimits(300_000),
    context_digest: batch.digest,
  };
}

function toWireIssue(issue: RootTree["issues"][number]): JsonRecord {
  const issueKind = issue.issue_kind ?? "work";
  return {
    issue_id: issue.issue_id,
    issue_kind: issueKind,
    ...(issue.parent_issue_id ? { parent_issue_id: issue.parent_issue_id } : {}),
    title: issue.title,
    description: issue.description,
    status: issue.status_name,
    is_archived: issue.is_archived,
    labels: issue.labels,
    remote_version: issue.remote_version,
  };
}

function toWireTreeComment(comment: RootTree["comments"][number]): JsonRecord {
  return {
    comment_id: comment.comment_id,
    comment_remote_version: comment.remote_version,
    issue_id: comment.issue_id,
    author_kind: comment.author_kind,
    author_id: comment.author_id,
    ...(comment.author_user_id ? { author_user_id: comment.author_user_id } : {}),
    body: comment.body,
    ...(comment.parent_comment_id ? { parent_comment_id: comment.parent_comment_id } : {}),
    thread_root_comment_id: comment.thread_root_comment_id,
    thread_state: comment.thread_state,
    reactions: comment.reactions.map((reaction) => ({
      reaction_id: reaction.reaction_id,
      emoji: reaction.emoji,
      actor_kind: reaction.actor_kind,
      actor_id: reaction.actor_id,
    })),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}

function toWireTreeRelation(relation: RootTree["relations"][number]): JsonRecord {
  return {
    relation_id: relation.relation_id,
    relation_kind: relation.relation_kind,
    source_issue_id: relation.source_issue_id,
    target_issue_id: relation.target_issue_id,
  };
}

function toWireFactIssue(issue: import("../../root-reconciliation/api/RootReconciliationContracts.js").RootFactIssue): JsonRecord {
  return {
    issue_id: issue.issueId,
    issue_kind: issue.issueKind,
    ...(issue.parentIssueId ? { parent_issue_id: issue.parentIssueId } : {}),
    ...(issue.creatorUserId ? { creator_user_id: issue.creatorUserId } : {}),
    ...(issue.assigneeUserId ? { assignee_user_id: issue.assigneeUserId } : {}),
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

function decodeDirective(value: unknown): RootDirective {
  const directive = record(value);
  const action = record(directive.action);
  if (directive.protocol_version !== "1" || typeof directive.root_directive_id !== "string" || typeof directive.based_on_target_root_digest !== "string") {
    throw new Error("root_directive_shape_invalid");
  }
  if (typeof action.kind !== "string" || !new Set([
    "execute_plan", "execute_work", "execute_verify", "rerun_stage", "revise_root_tree",
    "materialize_plan_node",
    "replan_current_cycle", "supersede_cycle", "create_cycle", "create_root_workspace", "create_human_action",
    "conclude_cycle", "conclude_root", "cancel_root", "wait", "acknowledge",
  ]).has(action.kind)) throw new Error("root_directive_action_invalid");
  return camelizeKeys(directive) as RootDirective;
}

function decodeRootTurnResult(value: unknown): RootReconcilerTurnResult {
  const response = record(value);
  if (response.kind !== "root_reconciler_failed") {
    return { kind: "directive", directive: decodeDirective(response) };
  }
  const failure = record(response.failure);
  const modelTurn = record(failure.model_turn);
  const rootIssueId = textValue(response, "root_issue_id");
  if (rootIssueId !== textValue(modelTurn, "root_issue_id")) {
    throw new Error("root_reconciler_failure_root_correlation_invalid");
  }
  const usage = record(modelTurn.usage);
  const continuity = record(failure.continuity);
  const continuityKind = enumValue(continuity, "kind", ["retained", "closed"]);
  return {
    kind: "failed",
    failure: {
      failureId: textValue(failure, "failure_id"),
      reconcilerSessionId: textValue(failure, "reconciler_session_id"),
      reconcilerTurnId: textValue(failure, "reconciler_turn_id"),
      targetRootDigest: textValue(failure, "target_root_digest"),
      attemptedInputIds: textArray(failure, "attempted_input_ids"),
      modelTurn: {
        turnRecordId: textValue(modelTurn, "turn_record_id"),
        role: "root_reconciler",
        rootIssueId: textValue(modelTurn, "root_issue_id"),
        reconcilerSessionId: textValue(modelTurn, "reconciler_session_id"),
        reconcilerTurnId: textValue(modelTurn, "reconciler_turn_id"),
        invocationState: enumValue(modelTurn, "invocation_state", ["confirmed", "ambiguous"]),
        model: textValue(modelTurn, "model"),
        outcome: enumValue(modelTurn, "outcome", ["directive_accepted", "transport_failed", "timed_out", "schema_invalid", "stale_output", "canceled"]),
        usage: usage.status === "measured"
          ? {
            status: "measured",
            inputTokens: numberValue(usage, "input_tokens"),
            cachedInputTokens: numberValue(usage, "cached_input_tokens"),
            outputTokens: numberValue(usage, "output_tokens"),
            reasoningOutputTokens: numberValue(usage, "reasoning_output_tokens"),
            totalTokens: numberValue(usage, "total_tokens"),
          }
          : { status: "unavailable", reason: enumValue(usage, "reason", ["provider_omitted", "transport_lost", "process_lost", "invalid_provider_usage"]) },
        terminalAt: textValue(modelTurn, "terminal_at"),
      },
      code: textValue(failure, "code"),
      category: enumValue(failure, "category", ["transport_failed", "timed_out", "schema_invalid", "stale_output", "canceled"]),
      sanitizedReason: textValue(failure, "sanitized_reason"),
      continuity: continuityKind === "retained"
        ? {
          kind: "retained",
          appendOutcome: enumValue(continuity, "append_outcome", ["not_accepted", "accepted"]),
          providerVisibleContextDigest: textValue(continuity, "provider_visible_context_digest"),
        }
        : {
          kind: "closed",
          appendOutcome: enumValue(continuity, "append_outcome", ["acceptance_unknown", "session_lost"]),
        },
      failedAt: textValue(failure, "failed_at"),
    },
  };
}

function textValue(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`agent_response_${key}_invalid`);
  return field;
}

function textArray(value: JsonRecord, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.some((entry) => typeof entry !== "string")) {
    throw new Error(`agent_response_${key}_invalid`);
  }
  return field as string[];
}

function numberValue(value: JsonRecord, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`agent_response_${key}_invalid`);
  }
  return field;
}

function enumValue<T extends string>(value: JsonRecord, key: string, variants: readonly T[]): T {
  const field = value[key];
  if (typeof field !== "string" || !variants.includes(field as T)) throw new Error(`agent_response_${key}_invalid`);
  return field as T;
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
    modelTurn: camelizeKeys(record(result.model_turn)) as StageResult["modelTurn"],
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
      ...(kind === "verify_changes_required" ? {
        conclusion: "changes_required" as const,
        findings: normalizeFindings(outcome.findings),
      } : {}),
      ...(kind === "verify_inconclusive" ? { conclusion: "inconclusive" as const } : {}),
    };
  }
  if (kind === "execution_failed") {
    const continuity = record(outcome.continuity);
    const continuityKind = enumValue(continuity, "kind", ["retained", "closed"]);
    return {
      kind,
      errorCode: string(outcome.error_code, "role_result_error_code_invalid"),
      continuity: continuityKind === "retained"
        ? {
          kind: "retained",
          appendOutcome: enumValue(continuity, "append_outcome", ["not_accepted", "accepted"]),
          providerVisibleContextDigest: textValue(continuity, "provider_visible_context_digest"),
        }
        : {
          kind: "closed",
          appendOutcome: enumValue(continuity, "append_outcome", ["acceptance_unknown", "session_lost"]),
        },
    };
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
      "linear_issue", "linear_comment", "git", "check", "result",
    ].includes(sourceKind)) {
      throw new Error("role_result_plan_evidence_invalid");
    }
    return { referenceId, sourceKind: sourceKind as NonNullable<StageResult["outcome"]["evidenceRefs"]>[number]["sourceKind"] };
  });
}

function normalizeFindings(value: unknown): NonNullable<StageResult["outcome"]["findings"]> {
  if (!Array.isArray(value)) throw new Error("role_result_findings_invalid");
  return value.map((entry) => {
    const finding = record(entry);
    const category = string(finding.category, "role_result_finding_category_invalid");
    const severity = string(finding.severity, "role_result_finding_severity_invalid");
    if (!["product", "code", "test", "infra", "requirement", "policy"].includes(category)) {
      throw new Error("role_result_finding_category_invalid");
    }
    if (!["critical", "high", "medium", "low"].includes(severity)) {
      throw new Error("role_result_finding_severity_invalid");
    }
    return {
      findingId: string(finding.finding_id, "role_result_finding_id_invalid"),
      category: category as NonNullable<StageResult["outcome"]["findings"]>[number]["category"],
      severity: severity as NonNullable<StageResult["outcome"]["findings"]>[number]["severity"],
      description: string(finding.description, "role_result_finding_description_invalid"),
      evidenceRefs: evidenceReferences(finding.evidence_refs),
      relatedWorkIssueIds: stringArray(finding.related_work_issue_ids, "role_result_finding_work_ids_invalid"),
    };
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
import { createHash } from "node:crypto";
