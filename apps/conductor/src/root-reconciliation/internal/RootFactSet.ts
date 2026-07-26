import { createHash } from "node:crypto";

import type { GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { cycleOutcomeId, parseManagedRecord } from "../api/index.js";
import { rootInputId } from "./RootInputIdentity.js";
import type {
  FindingRecord,
  ManagedRecord,
  PlanContract,
  StageResultRecord,
} from "../api/ManagedRecords.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import type {
  HumanActionKind,
  MechanicalViolation,
  RootBootstrap,
  RootBootstrapSnapshot,
  RootCommentThreadState,
  RootConvergenceSnapshot,
  RootDelta,
  RootDeltaChange,
  RootFactComment,
  RootFactIssue,
  RootFactRelation,
  RootGitFacts,
  RootHumanActionRecord,
  RootPlanCompletedResult,
  RootRecordReference,
  RootReconciliationView,
  UserCommentInput,
} from "../api/RootReconciliationContracts.js";

export interface RootFactEntry {
  key: string;
  change: RootDeltaChange;
}

export interface RootFactSet {
  bootstrap: RootBootstrap;
  entries: Map<string, RootFactEntry>;
}

export function buildRootFactSet(input: {
  root: DiscoveredRoot;
  tree: LinearWorkflowTreeSnapshot;
  git: GitWorkspaceSnapshot;
  convergence: RootConvergenceSnapshot;
  mechanicalViolations: MechanicalViolation[];
}): RootFactSet {
  const manifest = new Map(input.tree.source_manifest.map((entry) => [`${entry.source_kind}:${entry.source_id}`, entry]));
  const entries = new Map<string, RootFactEntry>();
  const issues = input.tree.issues.map((issue) => toFactIssue(issue));
  const rootIssue = issues.find(({ issueId }) => issueId === input.root.issueId);
  if (!rootIssue) throw new Error("root_fact_root_issue_missing");

  for (const issue of issues) {
    const source = manifest.get(`linear_issue:${issue.issueId}`);
    add(entries, `linear_issue:${issue.issueId}`, {
      kind: "issue_current_value",
      sourceId: issue.issueId,
      sourceVersion: source?.source_version ?? issue.remoteVersion,
      actorKind: source?.actor_kind ?? "unknown",
      observedAt: input.tree.observed_at,
      issue,
    });
  }

  const managedRecords: RootRecordReference[] = [];
  const managedRecordComments: Array<{
    comment: LinearWorkflowTreeSnapshot["comments"][number];
    record: ManagedRecord;
  }> = [];
  const userComments: RootFactComment[] = [];
  for (const comment of input.tree.comments) {
    if (comment.author_kind === "symphony") {
      const parsed = parseManagedRecord(comment.body);
      if (!parsed.ok) throw new Error(`root_managed_record_invalid:${parsed.error}`);
      const record = recordReference(parsed.value, manifest.get(`linear_comment:${comment.comment_id}`)?.stable_write_id);
      managedRecords.push(record);
      managedRecordComments.push({ comment, record: parsed.value });
      add(entries, `linear_record:${record.recordId}`, {
        kind: "managed_record_current_value",
        sourceId: record.recordId,
        sourceVersion: comment.remote_version,
        actorKind: "symphony",
        observedAt: comment.updated_at,
        record,
      });
      if (parsed.value.kind === "plan_contract") {
        add(entries, `linear_plan_contract:${comment.comment_id}`, {
          kind: "plan_contract_current_value",
          sourceId: comment.comment_id,
          sourceVersion: comment.remote_version,
          actorKind: "symphony",
          observedAt: comment.updated_at,
          planIssueId: comment.issue_id,
          planContract: parsed.value,
        });
      }
      if (isCompletedPlanResult(parsed.value)) {
        add(entries, `linear_plan_completed_result:${comment.comment_id}`, {
          kind: "plan_completed_result_current_value",
          sourceId: comment.comment_id,
          sourceVersion: comment.remote_version,
          actorKind: "symphony",
          observedAt: comment.updated_at,
          planCompletedResult: planCompletedResult(parsed.value),
        });
      }
      continue;
    }
    if (comment.author_kind === "linear_integration") continue;
    const source = manifest.get(`linear_comment:${comment.comment_id}`);
    const current = toFactComment(comment);
    userComments.push(current);
    const userInput = toCommentBodyInput(current, issues, input.tree);
    add(entries, `linear_comment_body:${comment.comment_id}`, {
      kind: "comment_current_value",
      sourceId: comment.comment_id,
      sourceVersion: userInput.commentBodyDigest,
      actorKind: source?.actor_kind ?? comment.author_kind,
      observedAt: comment.updated_at,
      userInput,
    });
  }

  const userCommentThreadStates: RootCommentThreadState[] = [];
  for (const comment of input.tree.comments) {
    if (isAcknowledgedThreadState(comment, managedRecordComments)) continue;
    const threadState = toCommentThreadState(comment, input.tree.observed_at);
    userCommentThreadStates.push(threadState);
    add(entries, `linear_comment_thread_state:${comment.comment_id}`, {
      kind: "comment_thread_state_current_value",
      sourceId: comment.comment_id,
      sourceVersion: threadState.commentRemoteVersion,
      actorKind: threadState.actorKind,
      observedAt: threadState.observedAt,
      threadState,
    });
  }

  const relations = input.tree.relations.map(toFactRelation);
  for (const relation of relations) {
    const source = manifest.get(`linear_relation:${relation.relationId}`);
    add(entries, `linear_relation:${relation.relationId}`, {
      kind: "relation_current_value",
      sourceId: relation.relationId,
      sourceVersion: source?.source_version ?? digest(relation),
      actorKind: source?.actor_kind ?? "unknown",
      observedAt: input.tree.observed_at,
      relation,
    });
  }

  const gitFacts = toGitFacts(input.git);
  add(entries, `git:${input.root.issueId}`, {
    kind: "git_facts_current_value",
    sourceId: `git:${input.root.issueId}`,
    sourceVersion: digest(gitFacts),
    actorKind: "symphony",
    observedAt: input.tree.observed_at,
    gitFacts,
  });
  add(entries, `mechanical:${input.root.issueId}`, {
    kind: "mechanical_violations_current_value",
    sourceId: `mechanical:${input.root.issueId}`,
    sourceVersion: digest(input.mechanicalViolations),
    actorKind: "symphony",
    observedAt: input.tree.observed_at,
    mechanicalViolations: input.mechanicalViolations,
  });
  add(entries, `convergence:${input.root.issueId}`, {
    kind: "convergence_current_value",
    sourceId: input.root.issueId,
    sourceVersion: digest(input.convergence),
    actorKind: "symphony",
    observedAt: input.tree.observed_at,
    convergence: input.convergence,
  });

  const cycles = input.tree.issues
    .filter((issue) => issue.issue_kind === "cycle")
    .map((cycle) => cycleObservation(cycle, input.tree, issues, managedRecordComments));
  const ownership = managedRecords.find(({ recordKind }) => recordKind === "root_ownership");
  if (!ownership) throw new Error("root_fact_ownership_missing");
  const delivery = managedRecords.find(({ recordKind }) => recordKind === "delivery") ?? null;
  const snapshot: RootBootstrapSnapshot = {
    root: {
      issue: rootIssue,
      objective: rootIssue.description || rootIssue.title,
      scope: rootIssue.title,
      acceptanceCriteria: [{
        criterionKey: `${rootIssue.issueId}:objective`,
        statement: rootIssue.description || rootIssue.title,
        verificationMethod: "provider-defined verification",
      }],
      constraints: [],
      rootStatus: rootIssue.status,
      ownership,
      convergence: input.convergence,
    },
    cycles,
    issues,
    relations,
    managedRecords,
    userComments,
    userCommentThreadStates,
    gitFacts,
    delivery,
    mechanicalViolations: input.mechanicalViolations,
  };
  const sourceManifest = input.tree.source_manifest.map((source) => ({
    sourceKind: source.source_kind,
    sourceId: source.source_id,
    sourceVersion: source.source_version,
    actorKind: source.actor_kind,
    ...(source.stable_write_id ? { stableWriteId: source.stable_write_id } : {}),
  }));
  const consumedInputIds = new Set(managedRecordComments.flatMap(({ record }) =>
    record.kind === "root_directive" ? record.consumedInputIds : []));
  const pendingInputIds = [...entries.values()]
    .filter(({ change }) =>
      change.actorKind !== "symphony" &&
      change.kind !== "git_facts_current_value" &&
      change.kind !== "mechanical_violations_current_value" &&
      (change.kind !== "comment_thread_state_current_value" || isPendingThreadState(change.threadState, input.tree)) &&
      !consumedInputIds.has(inputIdFor(change)),
    )
    .map(({ change }) => inputIdFor(change));
  const bootstrap: RootBootstrap = {
    rootSnapshot: snapshot,
    sourceManifest,
    coverage: {
      isComplete: input.tree.coverage.is_complete,
      omissions: input.tree.coverage.omissions.map(({ source_id, reason }) => ({ sourceId: source_id, reason })),
    },
    rootDigest: digest([...entries.values()].map(({ key, change }) => ({ key, change }))),
    pendingInputIds,
  };
  return { bootstrap, entries };
}

export function viewFromFactSet(input: {
  root: DiscoveredRoot;
  tree: LinearWorkflowTreeSnapshot;
  git: GitWorkspaceSnapshot;
  factSet: RootFactSet;
}): RootReconciliationView {
  return {
    root: input.root,
    tree: input.tree,
    git: input.git,
    observedAt: input.tree.observed_at,
    treeDigest: input.factSet.bootstrap.rootDigest,
    complete: true,
  };
}

export function diffRootFactSets(previous: RootFactSet, current: RootFactSet): RootDelta {
  const changes: RootDeltaChange[] = [];
  const keys = new Set([...previous.entries.keys(), ...current.entries.keys()]);
  for (const key of [...keys].sort()) {
    const before = previous.entries.get(key)?.change;
    const after = current.entries.get(key)?.change;
    if (before && after && unchangedCurrentValue(previous, current, before, after)) continue;
    if (after) changes.push(after);
    else if (before) {
      if (
        before.kind === "comment_thread_state_current_value" &&
        previous.entries.has(`linear_comment_body:${before.threadState.commentId}`)
      ) continue;
      changes.push(tombstone(before));
    }
  }
  return {
    baseRootDigest: previous.bootstrap.rootDigest,
    targetRootDigest: current.bootstrap.rootDigest,
    changes,
    pendingInputIds: changes
      .map((change) => inputIdFor(change))
      .filter((inputId) => current.bootstrap.pendingInputIds.includes(inputId)),
  };
}

function unchangedCurrentValue(
  previous: RootFactSet,
  current: RootFactSet,
  before: RootDeltaChange,
  after: RootDeltaChange,
): boolean {
  if (digest(before) === digest(after)) return true;
  if (before.kind === "comment_current_value" && after.kind === "comment_current_value") {
    return before.userInput.kind === "comment_body" && after.userInput.kind === "comment_body" &&
      before.userInput.commentBodyDigest === after.userInput.commentBodyDigest;
  }
  if (before.kind !== "comment_thread_state_current_value" || after.kind !== "comment_thread_state_current_value") {
    return false;
  }
  if (
    before.threadState.threadRootCommentId !== after.threadState.threadRootCommentId ||
    before.threadState.threadState !== after.threadState.threadState
  ) return false;

  const bodyKey = `linear_comment_body:${before.threadState.commentId}`;
  const beforeBody = previous.entries.get(bodyKey)?.change;
  const afterBody = current.entries.get(bodyKey)?.change;
  return beforeBody?.kind === "comment_current_value" && afterBody?.kind === "comment_current_value" &&
    beforeBody.userInput.kind === "comment_body" && afterBody.userInput.kind === "comment_body" &&
    beforeBody.userInput.commentBodyDigest !== afterBody.userInput.commentBodyDigest;
}

function add(entries: Map<string, RootFactEntry>, key: string, change: RootDeltaChange): void {
  entries.set(key, { key, change });
}

function tombstone(change: RootDeltaChange): RootDeltaChange {
  const base = {
    sourceId: change.sourceId,
    sourceVersion: change.sourceVersion,
    actorKind: change.actorKind,
    observedAt: change.observedAt,
  };
  if (change.kind.startsWith("issue_")) return { ...base, kind: "issue_detached" };
  if (change.kind.startsWith("comment_")) return { ...base, kind: "comment_removed" };
  if (change.kind.startsWith("relation_")) return { ...base, kind: "relation_removed" };
  if (change.kind.startsWith("managed_record_")) return { ...base, kind: "managed_record_removed" };
  if (change.kind === "plan_contract_current_value") {
    return {
      ...base,
      kind: "plan_contract_removed",
      cycleIssueId: change.planContract.cycleIssueId,
      planIssueId: change.planIssueId,
      planContractDigest: change.planContract.planContractDigest,
    };
  }
  if (change.kind === "plan_completed_result_current_value") {
    return {
      ...base,
      kind: "plan_completed_result_removed",
      cycleIssueId: change.planCompletedResult.cycleIssueId,
      resultId: change.planCompletedResult.resultId,
    };
  }
  return { ...base, kind: "mechanical_violations_current_value", mechanicalViolations: [] };
}

function toFactIssue(issue: LinearWorkflowTreeSnapshot["issues"][number]): RootFactIssue {
  const issueKind = issue.issue_kind === "human" ? "human_action" : issue.issue_kind;
  if (!issueKind) throw new Error("root_issue_kind_missing");
  return {
    issueId: issue.issue_id,
    issueKind,
    ...(issue.parent_issue_id ? { parentIssueId: issue.parent_issue_id } : {}),
    title: issue.title,
    description: issue.description,
    status: issue.status_name as RootFactIssue["status"],
    isArchived: issue.is_archived,
    labels: issue.labels,
    remoteVersion: issue.remote_version,
  };
}

function toFactComment(comment: LinearWorkflowTreeSnapshot["comments"][number]): RootFactComment {
  return {
    commentId: comment.comment_id,
    commentRemoteVersion: comment.remote_version,
    issueId: comment.issue_id,
    authorId: comment.author_id,
    ...(comment.author_user_id ? { authorUserId: comment.author_user_id } : {}),
    authorKind: comment.author_kind,
    ...(comment.parent_comment_id ? { parentCommentId: comment.parent_comment_id } : {}),
    threadRootCommentId: comment.thread_root_comment_id,
    threadState: comment.thread_state,
    reactions: comment.reactions.map((reaction) => ({
      reactionId: reaction.reaction_id,
      emoji: reaction.emoji,
      actorKind: reaction.actor_kind,
      actorId: reaction.actor_id,
    })),
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

function toCommentBodyInput(
  comment: RootFactComment,
  issues: RootFactIssue[],
  tree: LinearWorkflowTreeSnapshot,
): Extract<UserCommentInput, { kind: "comment_body" }> {
  const issue = issues.find(({ issueId }) => issueId === comment.issueId);
  if (!issue) throw new Error("root_comment_issue_missing");
  const cycleIssueId = cycleForIssue(comment.issueId, tree);
  const commentBodyDigest = bodyDigest(comment.body);
  return {
    kind: "comment_body",
    inputId: commentBodyInputId(comment.commentId, commentBodyDigest),
    commentId: comment.commentId,
    commentBodyDigest,
    issueId: comment.issueId,
    issueKind: issue.issueKind,
    ...(cycleIssueId ? { cycleIssueId } : {}),
    authorKind: comment.authorKind === "symphony" ? "unknown" : comment.authorKind,
    authorId: comment.authorId,
    ...(comment.authorUserId ? { authorUserId: comment.authorUserId } : {}),
    body: comment.body,
    threadRootCommentId: comment.threadRootCommentId,
    threadState: comment.threadState,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function toCommentThreadState(
  comment: LinearWorkflowTreeSnapshot["comments"][number],
  observedAt: string,
): RootCommentThreadState {
  return {
    commentId: comment.comment_id,
    commentRemoteVersion: comment.remote_version,
    threadRootCommentId: comment.thread_root_comment_id,
    threadState: comment.thread_state,
    // Linear exposes the current resolved state but not the resolving actor.
    actorKind: "unknown",
    observedAt,
  };
}

function isPendingThreadState(
  threadState: RootCommentThreadState,
  tree: LinearWorkflowTreeSnapshot,
): boolean {
  const comment = tree.comments.find(({ comment_id }) => comment_id === threadState.commentId);
  return Boolean(
    comment &&
    (threadState.threadState !== "unresolved" || comment.created_at !== comment.updated_at),
  );
}

function isAcknowledgedThreadState(
  comment: LinearWorkflowTreeSnapshot["comments"][number],
  records: Array<{ comment: LinearWorkflowTreeSnapshot["comments"][number]; record: ManagedRecord }>,
): boolean {
  return records.some(({ record }) => {
    if (record.kind !== "root_reconciler_reply" || record.source.commentId !== comment.comment_id) return false;
    const expectedState = record.threadAction === "resolve" ? "resolved" : "unresolved";
    return comment.thread_state === expectedState;
  });
}

function cycleForIssue(issueId: string, tree: LinearWorkflowTreeSnapshot): string | undefined {
  let current = tree.issues.find(({ issue_id }) => issue_id === issueId);
  const visited = new Set<string>();
  while (current && !visited.has(current.issue_id)) {
    visited.add(current.issue_id);
    if (current.issue_kind === "cycle") return current.issue_id;
    current = current.parent_issue_id
      ? tree.issues.find(({ issue_id }) => issue_id === current!.parent_issue_id)
      : undefined;
  }
  return undefined;
}

function toFactRelation(relation: LinearWorkflowTreeSnapshot["relations"][number]): RootFactRelation {
  return { relationId: relation.relation_id, relationKind: relation.relation_kind, sourceIssueId: relation.source_issue_id, targetIssueId: relation.target_issue_id };
}

function toGitFacts(git: GitWorkspaceSnapshot): RootGitFacts {
  return { headRevision: git.head, baselineRevision: git.head, statusSummary: git.status.items.join("\n") || "clean", changedPaths: git.status.items };
}

function cycleObservation(
  cycle: LinearWorkflowTreeSnapshot["issues"][number],
  tree: LinearWorkflowTreeSnapshot,
  issues: RootFactIssue[],
  managedRecordComments: Array<{
    comment: LinearWorkflowTreeSnapshot["comments"][number];
    record: ManagedRecord;
  }>,
) {
  const descendants = new Set<string>();
  for (const issue of tree.issues) {
    let current = issue.parent_issue_id;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current === cycle.issue_id) {
        descendants.add(issue.issue_id);
        break;
      }
      current = tree.issues.find(({ issue_id }) => issue_id === current)?.parent_issue_id;
    }
  }
  const cycleIssues = issues.filter(({ issueId }) => descendants.has(issueId));
  const cycleCommentIssueIds = new Set([cycle.issue_id, ...descendants]);
  const cycleRelations = tree.relations
    .filter((relation) => descendants.has(relation.source_issue_id) && descendants.has(relation.target_issue_id))
    .map(toFactRelation);
  const humanActionRecords = cycleIssues.filter(({ issueKind }) => issueKind === "human_action").map((issue) => humanActionRecord(issue, cycle.issue_id, tree));
  const humanActionIssueIds = new Set(humanActionRecords.map(({ actionIssueId }) => actionIssueId));
  const humanActionResolutions = tree.comments
    .map((comment) => parseManagedRecord(comment.body))
    .filter((parsed): parsed is { ok: true; value: Extract<ManagedRecord, { kind: "human_action_resolution" }> } =>
      parsed.ok && parsed.value.kind === "human_action_resolution" && humanActionIssueIds.has(parsed.value.actionIssueId))
    .map(({ value }) => ({
      resolutionId: value.resolutionId,
      actionId: value.actionId,
      actionIssueId: value.actionIssueId,
      actionKind: value.actionKind,
      outcome: value.outcome,
      terminalStatus: value.terminalStatus,
      terminalRemoteVersion: value.terminalRemoteVersion,
      proposalDigest: value.proposalDigest,
      sourceCommentIds: value.sourceCommentIds,
      actorKind: value.actorKind,
      resolvedAt: value.resolvedAt,
    }));
  const planResults = managedRecordComments.flatMap((entry) =>
    isCompletedPlanResult(entry.record) &&
    entry.record.rootIssueId === tree.root_issue_id &&
    entry.record.cycleIssueId === cycle.issue_id &&
    descendants.has(entry.record.nodeIssueId)
      ? [{ comment: entry.comment, record: entry.record }]
      : [],
  );
  const workResults = managedRecordComments.flatMap((entry) =>
    entry.record.kind === "stage_result" &&
    entry.record.stage === "work" &&
    entry.record.rootIssueId === tree.root_issue_id &&
    entry.record.cycleIssueId === cycle.issue_id &&
    descendants.has(entry.record.nodeIssueId)
      ? [{ comment: entry.comment, record: entry.record }]
      : [],
  );
  const verifyResults = managedRecordComments.flatMap((entry) =>
    entry.record.kind === "verify_result" &&
    entry.record.rootIssueId === tree.root_issue_id &&
    entry.record.cycleIssueId === cycle.issue_id &&
    descendants.has(entry.record.nodeIssueId)
      ? [{ comment: entry.comment, record: entry.record }]
      : [],
  );
  const verifyExecutionIds = new Set(verifyResults.map(({ record }) => record.stageExecutionId));
  const findings = managedRecordComments.flatMap((entry) =>
    entry.record.kind === "finding" &&
    cycleCommentIssueIds.has(entry.comment.issue_id) &&
    verifyExecutionIds.has(entry.record.sourceVerifyId)
      ? [rootFinding(entry.record)]
      : [],
  );
  const outcomes = managedRecordComments.flatMap((entry) =>
    entry.record.kind === "cycle_outcome" &&
    entry.comment.issue_id === cycle.issue_id &&
    entry.record.rootIssueId === tree.root_issue_id &&
    entry.record.cycleIssueId === cycle.issue_id &&
    entry.record.cycleOutcomeId === cycleOutcomeId({
      rootIssueId: entry.record.rootIssueId,
      cycleIssueId: entry.record.cycleIssueId,
      rootDirectiveId: entry.record.sourceRootDirectiveId,
    })
      ? [{ comment: entry.comment, record: entry.record }]
      : [],
  );
  const activePlanIssueIds = new Set(tree.issues
    .filter((issue) => issue.parent_issue_id === cycle.issue_id && issue.issue_kind === "plan" && !issue.is_archived && issue.status_name === "In Review")
    .map(({ issue_id }) => issue_id));
  const activePlanContracts = managedRecordComments
    .filter((entry): entry is { comment: LinearWorkflowTreeSnapshot["comments"][number]; record: PlanContract } =>
      entry.record.kind === "plan_contract" &&
      entry.record.rootIssueId === tree.root_issue_id &&
      entry.record.cycleIssueId === cycle.issue_id &&
      activePlanIssueIds.has(entry.comment.issue_id),
    )
    .sort((left, right) => right.comment.updated_at.localeCompare(left.comment.updated_at) || right.comment.comment_id.localeCompare(left.comment.comment_id));
  return {
    cycleIssue: toFactIssue(cycle),
    predecessorCycleIssueId: cycle.parent_issue_id ?? "none",
    cycleStatus: cycle.status_name as RootFactIssue["status"],
    isArchived: cycle.is_archived,
    ...(activePlanContracts[0] ? { activePlanContract: activePlanContracts[0].record } : {}),
    ...(outcomes.length === 1 ? { outcome: recordReference(outcomes[0]!.record) } : {}),
    issues: cycleIssues,
    relations: cycleRelations,
    planResults: planResults.map(({ comment, record }) => recordReference(record, comment.remote_version)),
    planCompletedResults: planResults.map(({ record }) => planCompletedResult(record)),
    workResults: workResults.map(({ record }) => recordReference(record)),
    verifyResults: verifyResults.map(({ record }) => recordReference(record)),
    findings,
    humanActionRecords,
    humanActionResolutions,
  };
}

function rootFinding(record: FindingRecord) {
  return {
    findingId: record.findingId,
    category: record.category,
    severity: record.severity,
    summary: record.suggestedRemediation.join(" ") || `Finding ${record.findingId}.`,
  };
}

type CompletedPlanManagedRecord = StageResultRecord & {
  outcomeKind: "plan_completed";
  planContractDigest: string;
  planContract: NonNullable<StageResultRecord["planContract"]>;
  proposedWorkDag: NonNullable<StageResultRecord["proposedWorkDag"]>;
  risks: string[];
  requiredPermissions: string[];
  evidenceRefs: NonNullable<StageResultRecord["evidenceRefs"]>;
};

function isCompletedPlanResult(record: ManagedRecord): record is CompletedPlanManagedRecord {
  return record.kind === "stage_result" &&
    record.stage === "plan" &&
    record.outcomeKind === "plan_completed" &&
    record.planContractDigest !== undefined &&
    record.planContract !== undefined &&
    record.proposedWorkDag !== undefined &&
    record.risks !== undefined &&
    record.requiredPermissions !== undefined &&
    record.evidenceRefs !== undefined;
}

function planCompletedResult(record: CompletedPlanManagedRecord): RootPlanCompletedResult {
  return {
    resultId: record.resultId,
    rootIssueId: record.rootIssueId,
    cycleIssueId: record.cycleIssueId,
    nodeIssueId: record.nodeIssueId,
    summary: record.summary,
    completedAt: record.completedAt,
    planContractDigest: record.planContractDigest,
    planContract: record.planContract,
    proposedWorkDag: record.proposedWorkDag,
    risks: record.risks,
    requiredPermissions: record.requiredPermissions,
    evidenceRefs: record.evidenceRefs,
  };
}

function humanActionRecord(issue: RootFactIssue, cycleIssueId: string, tree: LinearWorkflowTreeSnapshot): RootHumanActionRecord {
  const actionKind = actionKindFor(issue.labels);
  const relatedIssueIds = tree.relations.flatMap((relation) => {
    const relatedId = relation.source_issue_id === issue.issueId ? relation.target_issue_id : relation.target_issue_id === issue.issueId ? relation.source_issue_id : undefined;
    if (!relatedId) return [];
    const target = tree.issues.find(({ issue_id }) => issue_id === relatedId);
    return target && ["plan", "work", "verify"].includes(target.issue_kind ?? "") ? [relatedId] : [];
  });
  return { actionId: issue.issueId, actionIssueId: issue.issueId, actionKind, parentScope: "cycle", cycleIssueId, status: issue.status, isArchived: issue.isArchived, relatedIssueIds };
}

function actionKindFor(labels: string[]): HumanActionKind {
  const mapping: Array<[string, HumanActionKind]> = [
    ["Plan Review", "plan_review"], ["Clarification", "clarification"], ["Permission", "permission"],
    ["Finding Waiver", "finding_waiver"], ["Convergence Override", "convergence_override"],
  ];
  const found = mapping.find(([label]) => labels.includes(label));
  if (!labels.includes("Human Action") || !found) throw new Error("human_action_label_invalid");
  return found[1];
}

function recordReference(record: ManagedRecord, stableWriteId?: string): RootRecordReference {
  const identity = "replyId" in record ? record.replyId
    : "resultId" in record ? record.resultId
    : "resolutionId" in record ? record.resolutionId
      : "rootDirectiveId" in record ? record.rootDirectiveId
      : "actionId" in record ? record.actionId
        : "supersessionId" in record ? record.supersessionId
          : "cycleOutcomeId" in record ? record.cycleOutcomeId
        : `${record.kind}:${digest(record).slice(0, 24)}`;
  return {
    recordId: identity,
    recordKind: record.kind,
    recordVersion: "1",
    writeId: stableWriteId ?? identity,
  };
}

function inputIdFor(change: RootDeltaChange): string {
  if (change.kind === "comment_current_value") return change.userInput.inputId;
  if (change.kind === "comment_thread_state_current_value") {
    return threadStateInputId(change.threadState);
  }
  return rootInputId(change.sourceId, change.sourceVersion);
}

function commentBodyInputId(commentId: string, commentBodyDigest: string): string {
  return rootInputId(`comment_body:${commentId}`, commentBodyDigest);
}

function threadStateInputId(threadState: RootCommentThreadState): string {
  return rootInputId(
    `comment_thread_state:${threadState.commentId}:${threadState.threadRootCommentId}:${threadState.threadState}`,
    threadState.commentRemoteVersion,
  );
}

function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
