import {
  decodeConductorPerformerStageContextEnvelope,
  type JsonValue,
} from "@symphony/contracts";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

import type { GitWorkspace, GitWorkspaceInterface, GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  CycleMarker,
  FindingDispositionRecord,
  FindingRecord,
  ManagedRecord,
  PlanContract,
  StageExecutionRecord,
  StageTerminalRecord,
} from "../../root-workflow/api/ManagedRecords.js";
import { parseManagedRecord } from "../../root-workflow/api/index.js";
import type { BootstrapPlanOptions } from "../api/LinearDagExecutionInterface.js";

type Issue = LinearWorkflowTreeSnapshot["issues"][number];
type Comment = LinearWorkflowTreeSnapshot["comments"][number];

export interface PlanStageContextBuildInput {
  tree: LinearWorkflowTreeSnapshot;
  cycle: Issue;
  plan: Issue;
  workspace: GitWorkspace;
  git: GitWorkspaceInterface;
  stageExecutionId: string;
  startedAt: string;
  deadlineAt: string;
  options: BootstrapPlanOptions;
}

export interface PlanStageContextBuildResult {
  envelope: JsonValue;
  executionRecord: StageExecutionRecord;
}

export interface WorkStageContextBuildInput {
  tree: LinearWorkflowTreeSnapshot;
  cycle: Issue;
  plan: Issue;
  work: Issue;
  contract: PlanContract;
  dependencyState: Array<{ workKey: string; terminalOutcome: "completed" | "failed" | "canceled"; commitRevision?: string }>;
  workspace: GitWorkspace;
  git: GitWorkspaceInterface;
  stageExecutionId: string;
  startedAt: string;
  deadlineAt: string;
  options: BootstrapPlanOptions;
}

export interface WorkStageContextBuildResult {
  envelope: JsonValue;
  executionRecord: StageExecutionRecord;
}

export class StageContextBuilder {
  async build(input: PlanStageContextBuildInput): Promise<PlanStageContextBuildResult> {
    const { tree, cycle, plan, options } = input;
    const root = tree.issues.find((issue) => issue.issue_id === tree.root_issue_id);
    if (!root || cycle.parent_issue_id !== root.issue_id || plan.parent_issue_id !== cycle.issue_id) {
      throw new Error("plan_context_target_invalid");
    }
    const records = readRecords(tree.comments);
    const cycleMarker = oneRecord(records.get(cycle.issue_id) ?? [], "cycle_marker") as CycleMarker | undefined;
    if (!cycleMarker) throw new Error("plan_context_cycle_marker_missing");

    const gitSnapshot = await input.git.inspect(input.workspace);
    const diff = await input.git.diff(input.workspace, {
      fromRevision: cycleMarker.baselineRevision,
      toRevision: gitSnapshot.head,
    });
    if (diff.partial || diff.bytes > 16_384) throw new Error("plan_context_diff_exceeded");

    const predecessor = predecessorContext(tree, cycle, records);
    const stageSources = sources(tree, records, root, cycle, plan, gitSnapshot, diff, options);
    const workflowContext = {
      root: {
        identifier: root.identifier,
        title: root.title,
        objective: root.description,
        acceptance_criteria: [],
        relevant_comments: contentRecords(tree.comments.filter((comment) => comment.issue_id === root.issue_id)),
        remote_version: root.remote_version,
      },
      cycle: {
        cycle_key: cycleMarker.cycleKey,
        trigger: cycleMarker.trigger,
        ...(predecessor === undefined ? {} : { predecessor_cycle: predecessor }),
      },
      actual_changes: {
        baseline_revision: cycleMarker.baselineRevision,
        target_revision: gitSnapshot.head,
        diff_entries: diffEntries(diff.text),
        diff_summary: diff.text || "No changes yet.",
      },
      unresolved_findings: unresolvedFindings(records),
      attempted_approaches: attemptedApproaches(records),
      review_inputs: contentRecords(tree.comments.filter((comment) => comment.issue_id !== root.issue_id)),
      existing_nodes: tree.issues
        .filter((issue) => issue.issue_kind !== "root")
        .map((issue) => ({
          issue_id: issue.issue_id,
          kind: issue.issue_kind!,
          title: issue.title,
          business_state: issue.status_name,
          blocked_by_issue_ids: blockedBy(tree, issue.issue_id),
        })),
      repository_snapshot: {
        head_revision: gitSnapshot.head,
        status_summary: statusSummary(gitSnapshot),
        top_level_paths: await topLevelPaths(input.workspace.worktreePath),
      },
    };
    const repositoryInstructions = (options.repositoryInstructions ?? []).map((instruction) => ({
      relative_path: instruction.relativePath,
      content_digest: instruction.contentDigest,
      content: instruction.content,
    }));
    const envelopeWithoutDigest = {
      protocol_version: "1",
      stage_execution: {
        stage_execution_id: input.stageExecutionId,
        stage: "plan",
        started_at: input.startedAt,
        deadline_at: input.deadlineAt,
      },
      target: {
        root_issue_id: root.issue_id,
        cycle_issue_id: cycle.issue_id,
        node_issue_id: plan.issue_id,
      },
      source_manifest: stageSources,
      coverage: { is_complete: true, omissions: [] },
      instruction_bundle: {
        stage_instruction_set_id: options.instructionSetId,
        stage_instructions: options.stageInstructions,
        output_schema: "StageResult.outcome=plan_completed",
        repository_instructions: repositoryInstructions,
      },
      workflow_context: workflowContext,
      repository_context: {
        repository_identity: options.repositoryIdentity,
        base_branch: options.baseBranch,
        workspace_revision: gitSnapshot.head,
        baseline_revision: cycleMarker.baselineRevision,
        status_summary: statusSummary(gitSnapshot),
        relevant_paths: await topLevelPaths(input.workspace.worktreePath),
        workspace_access: "read_only",
      },
      execution_policy: {
        performer_profile_id: options.performerProfileId,
        model_settings: {
          model: options.modelSettings.model,
          reasoning_effort: options.modelSettings.reasoningEffort,
          is_fast_mode_enabled: options.modelSettings.isFastModeEnabled,
        },
        sandbox_mode: "read_only",
        allowed_tools: ["read"],
        denied_tools: ["linear", "git_commit"],
        network_policy: "restricted",
      },
      limits: {
        max_context_bytes: options.limits.maxContextBytes,
        max_result_bytes: options.limits.maxResultBytes,
        max_wall_time_ms: options.limits.maxWallTimeMs,
        max_tool_calls: options.limits.maxToolCalls,
        max_command_duration_ms: options.limits.maxCommandDurationMs,
        reserved_total_tokens: options.limits.reservedTotalTokens,
        max_output_tokens: options.limits.maxOutputTokens,
      },
    };
    const contextDigest = digest(envelopeWithoutDigest);
    const envelope = decodeConductorPerformerStageContextEnvelope({
      ...envelopeWithoutDigest,
      context_digest: contextDigest,
    } as unknown as JsonValue) as JsonValue;
    const executionRecord: StageExecutionRecord = {
      kind: "stage_execution",
      version: 1,
      stageExecutionId: input.stageExecutionId,
      rootIssueId: root.issue_id,
      cycleIssueId: cycle.issue_id,
      nodeIssueId: plan.issue_id,
      stage: "plan",
      contextDigest,
      sourceManifest: stageSources.map((source) => ({
        sourceKind: source.source_kind,
        sourceId: source.source_id,
        versionOrDigest: source.version_or_digest,
      })),
      coverage: { isComplete: true, omissions: [] },
      instructionSetId: options.instructionSetId,
      executionPolicyId: `${options.performerProfileId}:${options.modelSettings.model}`,
      limits: options.limits,
      repositoryRevision: gitSnapshot.head,
      startedAt: input.startedAt,
      deadlineAt: input.deadlineAt,
    };
    return { envelope, executionRecord };
  }

  async buildWork(input: WorkStageContextBuildInput): Promise<WorkStageContextBuildResult> {
    const { tree, cycle, plan, work, contract, options } = input;
    const root = tree.issues.find((issue) => issue.issue_id === tree.root_issue_id);
    if (!root || cycle.parent_issue_id !== root.issue_id || plan.parent_issue_id !== cycle.issue_id || work.parent_issue_id !== cycle.issue_id || work.issue_kind !== "work") {
      throw new Error("work_context_target_invalid");
    }
    const records = readRecords(tree.comments);
    const cycleMarker = oneRecord(records.get(cycle.issue_id) ?? [], "cycle_marker") as CycleMarker | undefined;
    if (!cycleMarker) throw new Error("work_context_cycle_marker_missing");
    const gitSnapshot = await input.git.inspect(input.workspace);
    if (gitSnapshot.status.partial || gitSnapshot.status.has_more || gitSnapshot.status.items.length > 0) throw new Error("work_context_git_baseline_dirty");
    const stageSources = workSources(tree, root, cycle, plan, work, gitSnapshot, options);
    const workContract = contract.workNodes.find((node) => node.workKey === nodeKey(records.get(work.issue_id) ?? []));
    if (!workContract) throw new Error("work_context_contract_missing");
    const workflowContext = {
      root_boundary: {
        root_issue_id: root.issue_id,
        objective_summary: contract.objectiveSummary,
        included_scope: contract.includedScope,
        excluded_scope: contract.excludedScope,
        relevant_acceptance_criteria: contract.acceptanceCriteria.map(toCriterion),
      },
      work_node: {
        issue_id: work.issue_id,
        work_key: workContract.workKey,
        title: workContract.title,
        description: workContract.description,
        acceptance_criteria: workContract.acceptanceCriteria.map(toCriterion),
        relevant_comments: contentRecords(tree.comments.filter((comment) => comment.issue_id === work.issue_id)),
        remote_version: work.remote_version,
      },
      dependency_state: input.dependencyState.map((dependency) => ({
        work_key: dependency.workKey,
        terminal_outcome: dependency.terminalOutcome,
        ...(dependency.commitRevision === undefined ? {} : { commit_revision: dependency.commitRevision }),
      })),
      resolved_human_input: [],
      git_baseline: { head_revision: gitSnapshot.head, status_summary: statusSummary(gitSnapshot) },
    };
    const repositoryInstructions = (options.repositoryInstructions ?? []).map((instruction) => ({
      relative_path: instruction.relativePath,
      content_digest: instruction.contentDigest,
      content: instruction.content,
    }));
    const envelopeWithoutDigest = {
      protocol_version: "1",
      stage_execution: { stage_execution_id: input.stageExecutionId, stage: "work", started_at: input.startedAt, deadline_at: input.deadlineAt },
      target: { root_issue_id: root.issue_id, cycle_issue_id: cycle.issue_id, node_issue_id: work.issue_id, plan_contract_digest: contract.planContractDigest },
      source_manifest: stageSources,
      coverage: { is_complete: true, omissions: [] },
      instruction_bundle: {
        stage_instruction_set_id: options.instructionSetId,
        stage_instructions: options.stageInstructions,
        output_schema: "StageResult.outcome=work_completed",
        repository_instructions: repositoryInstructions,
      },
      workflow_context: workflowContext,
      repository_context: {
        repository_identity: options.repositoryIdentity,
        base_branch: options.baseBranch,
        workspace_revision: gitSnapshot.head,
        baseline_revision: gitSnapshot.head,
        status_summary: statusSummary(gitSnapshot),
        relevant_paths: await topLevelPaths(input.workspace.worktreePath),
        workspace_access: "read_write",
      },
      execution_policy: {
        performer_profile_id: options.performerProfileId,
        model_settings: { model: options.modelSettings.model, reasoning_effort: options.modelSettings.reasoningEffort, is_fast_mode_enabled: options.modelSettings.isFastModeEnabled },
        sandbox_mode: "workspace_write",
        allowed_tools: ["read", "write", "shell"],
        denied_tools: ["linear", "git_commit", "git_push", "git_branch", "git_worktree", "delivery"],
        network_policy: "restricted",
      },
      limits: {
        max_context_bytes: options.limits.maxContextBytes,
        max_result_bytes: options.limits.maxResultBytes,
        max_wall_time_ms: options.limits.maxWallTimeMs,
        max_tool_calls: options.limits.maxToolCalls,
        max_command_duration_ms: options.limits.maxCommandDurationMs,
        reserved_total_tokens: options.limits.reservedTotalTokens,
        max_output_tokens: options.limits.maxOutputTokens,
      },
    };
    const contextDigest = digest(envelopeWithoutDigest);
    const envelope = decodeConductorPerformerStageContextEnvelope({ ...envelopeWithoutDigest, context_digest: contextDigest } as unknown as JsonValue) as JsonValue;
    return {
      envelope,
      executionRecord: {
        kind: "stage_execution", version: 1, stageExecutionId: input.stageExecutionId, rootIssueId: root.issue_id, cycleIssueId: cycle.issue_id, nodeIssueId: work.issue_id, stage: "work", planContractDigest: contract.planContractDigest,
        contextDigest, sourceManifest: stageSources.map((source) => ({ sourceKind: source.source_kind, sourceId: source.source_id, versionOrDigest: source.version_or_digest })), coverage: { isComplete: true, omissions: [] }, instructionSetId: options.instructionSetId, executionPolicyId: `${options.performerProfileId}:${options.modelSettings.model}`, limits: options.limits, repositoryRevision: gitSnapshot.head, startedAt: input.startedAt, deadlineAt: input.deadlineAt,
      },
    };
  }
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readRecords(comments: Comment[]): Map<string, ManagedRecord[]> {
  const result = new Map<string, ManagedRecord[]>();
  for (const comment of comments) {
    if (!comment.managed_marker) continue;
    const parsed = parseManagedRecord(comment.body);
    if (!parsed.ok) throw new Error("plan_context_managed_record_invalid");
    const records = result.get(comment.issue_id) ?? [];
    records.push(parsed.value);
    result.set(comment.issue_id, records);
  }
  return result;
}

function nodeKey(records: ManagedRecord[]): string | undefined {
  const marker = records.find((record): record is Extract<ManagedRecord, { kind: "node_marker" }> => record.kind === "node_marker" && record.nodeKind === "work");
  return marker?.nodeKey;
}

function oneRecord(records: ManagedRecord[], kind: ManagedRecord["kind"]): ManagedRecord | undefined {
  const matches = records.filter((record) => record.kind === kind);
  if (matches.length > 1) throw new Error(`plan_context_${kind}_duplicate`);
  return matches[0];
}

function sources(
  tree: LinearWorkflowTreeSnapshot,
  records: Map<string, ManagedRecord[]>,
  root: Issue,
  cycle: Issue,
  plan: Issue,
  git: GitWorkspaceSnapshot,
  diff: { text: string },
  options: BootstrapPlanOptions,
) {
  const result: Array<{ source_kind: "linear_issue" | "linear_comment" | "linear_relation" | "git" | "repository_instruction"; source_id: string; version_or_digest: string }> = [
    { source_kind: "linear_issue", source_id: root.issue_id, version_or_digest: root.remote_version },
    { source_kind: "linear_issue", source_id: cycle.issue_id, version_or_digest: cycle.remote_version },
    { source_kind: "linear_issue", source_id: plan.issue_id, version_or_digest: plan.remote_version },
    { source_kind: "git", source_id: `git:baseline:${(records.get(cycle.issue_id) ?? []).find((record): record is CycleMarker => record.kind === "cycle_marker")?.baselineRevision ?? git.head}`, version_or_digest: digest({ head: git.head, diff: diff.text }) },
  ];
  for (const comment of tree.comments.filter((comment) => !comment.managed_marker)) {
    result.push({ source_kind: "linear_comment", source_id: comment.comment_id, version_or_digest: comment.remote_version });
  }
  for (const relation of tree.relations) {
    result.push({ source_kind: "linear_relation", source_id: relation.relation_id, version_or_digest: `${relation.source_issue_id}:${relation.target_issue_id}` });
  }
  for (const instruction of options.repositoryInstructions ?? []) {
    result.push({ source_kind: "repository_instruction", source_id: `instruction:${digest(instruction.relativePath).slice(7, 39)}`, version_or_digest: instruction.contentDigest });
  }
  return result;
}

function workSources(
  tree: LinearWorkflowTreeSnapshot,
  root: Issue,
  cycle: Issue,
  plan: Issue,
  work: Issue,
  git: GitWorkspaceSnapshot,
  options: BootstrapPlanOptions,
) {
  const result: Array<{ source_kind: "linear_issue" | "linear_comment" | "linear_relation" | "git" | "repository_instruction"; source_id: string; version_or_digest: string }> = [
    { source_kind: "linear_issue", source_id: root.issue_id, version_or_digest: root.remote_version },
    { source_kind: "linear_issue", source_id: cycle.issue_id, version_or_digest: cycle.remote_version },
    { source_kind: "linear_issue", source_id: plan.issue_id, version_or_digest: plan.remote_version },
    { source_kind: "linear_issue", source_id: work.issue_id, version_or_digest: work.remote_version },
    { source_kind: "git", source_id: `git:work:${work.issue_id}`, version_or_digest: digest({ head: git.head, status: git.status.items }) },
  ];
  for (const comment of tree.comments.filter((comment) => !comment.managed_marker && [root.issue_id, cycle.issue_id, plan.issue_id, work.issue_id].includes(comment.issue_id))) {
    result.push({ source_kind: "linear_comment", source_id: comment.comment_id, version_or_digest: comment.remote_version });
  }
  for (const relation of tree.relations) result.push({ source_kind: "linear_relation", source_id: relation.relation_id, version_or_digest: `${relation.source_issue_id}:${relation.target_issue_id}` });
  for (const instruction of options.repositoryInstructions ?? []) result.push({ source_kind: "repository_instruction", source_id: `instruction:${digest(instruction.relativePath).slice(7, 39)}`, version_or_digest: instruction.contentDigest });
  return result;
}

function contentRecords(comments: Comment[]) {
  return comments.filter((comment) => !comment.managed_marker).map((comment) => ({
    source_id: comment.comment_id,
    source_kind: "comment",
    text: comment.body,
    author_kind: "human",
    remote_version: comment.remote_version,
    updated_at: comment.updated_at,
  }));
}

function predecessorContext(tree: LinearWorkflowTreeSnapshot, cycle: Issue, records: Map<string, ManagedRecord[]>) {
  const predecessor = tree.issues
    .filter((issue) => issue.issue_kind === "cycle" && issue.parent_issue_id === tree.root_issue_id && issue.order < cycle.order)
    .sort((left, right) => right.order - left.order)[0];
  if (!predecessor) return undefined;
  const plan = tree.issues.find((issue) => issue.issue_kind === "plan" && issue.parent_issue_id === predecessor.issue_id);
  const contract = plan && oneRecord(records.get(plan.issue_id) ?? [], "plan_contract") as PlanContract | undefined;
  const verify = tree.issues.find((issue) => issue.issue_kind === "verify" && issue.parent_issue_id === predecessor.issue_id);
  const terminal = verify && latestTerminal(records.get(verify.issue_id) ?? [], "verify");
  if (!plan || !contract || !verify || !terminal) return undefined;
  const execution = oneRecord(records.get(verify.issue_id) ?? [], "stage_execution") as StageExecutionRecord | undefined;
  return {
    cycle_issue_id: predecessor.issue_id,
    approved_plan: toStagePlan(contract),
    verify_evidence: {
      verify_result_id: terminal.stageExecutionId,
      verified_revision: execution?.repositoryRevision ?? "unknown-revision",
      criteria_results: [],
      checks: [],
    },
    completion_summary: terminal.summary,
  };
}

function toStagePlan(contract: PlanContract) {
  return {
    objective_summary: contract.objectiveSummary,
    included_scope: contract.includedScope,
    excluded_scope: contract.excludedScope,
    acceptance_criteria: contract.acceptanceCriteria.map(toCriterion),
    work_nodes: contract.workNodes.map((node) => ({
      work_key: node.workKey,
      title: node.title,
      description: node.description,
      acceptance_criteria: node.acceptanceCriteria.map(toCriterion),
      dependency_work_keys: node.dependencyWorkKeys,
    })),
    verify_node: {
      title: contract.verifyNode.title,
      acceptance_criteria: contract.verifyNode.acceptanceCriteria.map(toCriterion),
      required_checks: contract.verifyNode.requiredChecks.map((check) => check.commandOrMethod),
    },
  };
}

function toCriterion(value: { criterionKey: string; statement: string; verificationMethod: string }) {
  return { criterion_key: value.criterionKey, statement: value.statement, verification_method: value.verificationMethod };
}

function unresolvedFindings(records: Map<string, ManagedRecord[]>): Array<{ finding_id: string; category: FindingRecord["category"]; severity: FindingRecord["severity"]; summary: string }> {
  const findings = [...records.values()].flatMap((values) => values.filter((record): record is FindingRecord => record.kind === "finding"));
  const dispositions = new Map([...records.values()].flatMap((values) => values.filter((record): record is FindingDispositionRecord => record.kind === "finding_disposition")).map((record) => [record.findingId, record.disposition]));
  return findings.filter((finding) => dispositions.get(finding.findingId) !== "resolved" && dispositions.get(finding.findingId) !== "waived")
    .map((finding) => ({ finding_id: finding.findingId, category: finding.category, severity: finding.severity, summary: finding.suggestedRemediation.join("; ") || `Open ${finding.category} finding.` }));
}

function attemptedApproaches(records: Map<string, ManagedRecord[]>) {
  return [...records.values()].flatMap((values) => values.filter((record): record is StageTerminalRecord => record.kind === "stage_terminal" && record.stage !== "plan")
    .map((record) => ({ attempt_key: record.stageExecutionId, summary: record.summary, outcome: record.outcome })));
}

function latestTerminal(records: ManagedRecord[], stage: StageTerminalRecord["stage"]): StageTerminalRecord | undefined {
  return records.filter((record): record is StageTerminalRecord => record.kind === "stage_terminal" && record.stage === stage)
    .sort((left, right) => left.completedAt.localeCompare(right.completedAt)).at(-1);
}

function blockedBy(tree: LinearWorkflowTreeSnapshot, issueId: string): string[] {
  return tree.relations.flatMap((relation) => relation.relation_kind === "blocks" && relation.target_issue_id === issueId
    ? [relation.source_issue_id] : relation.relation_kind === "blocked_by" && relation.source_issue_id === issueId ? [relation.target_issue_id] : []);
}

function diffEntries(text: string) {
  return [...text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gmu)].map((match) => ({
    relative_path: match[2]!,
    change_kind: "modified",
  }));
}

function statusSummary(snapshot: GitWorkspaceSnapshot): string {
  return snapshot.status.items.length === 0 ? "clean" : snapshot.status.items.join("\n");
}

async function topLevelPaths(worktreePath: string): Promise<string[]> {
  try {
    return (await readdir(worktreePath, { withFileTypes: true }))
      .filter((entry) => entry.name !== ".git")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
