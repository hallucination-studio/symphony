import { createHash } from "node:crypto";

import type { GitWorkspaceSnapshot } from "../../git-workspaces/api/GitWorkspaceInterface.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import { parseManagedRecord } from "../api/index.js";
import type { ManagedRecord } from "../api/ManagedRecords.js";
import type { DiscoveredRoot } from "../api/RootModels.js";
import type {
  HumanActionKind,
  MechanicalViolation,
  RootBootstrap,
  RootBootstrapSnapshot,
  RootDelta,
  RootDeltaChange,
  RootFactComment,
  RootFactIssue,
  RootFactRelation,
  RootGitFacts,
  RootHumanActionRecord,
  RootRecordReference,
  RootReconciliationView,
  RootSourceManifestEntry,
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
  const userComments: RootFactComment[] = [];
  for (const comment of input.tree.comments) {
    if (comment.body.startsWith("<!-- symphony managed-record\n")) {
      const parsed = parseManagedRecord(comment.body);
      if (!parsed.ok) throw new Error(`root_managed_record_invalid:${parsed.error}`);
      const record = recordReference(parsed.value, comment.remote_version);
      managedRecords.push(record);
      add(entries, `linear_record:${record.recordId}`, {
        kind: "managed_record_current_value",
        sourceId: record.recordId,
        sourceVersion: comment.remote_version,
        actorKind: "symphony",
        observedAt: comment.updated_at,
        record,
      });
      continue;
    }
    if (comment.managed_marker || comment.author_kind === "symphony") continue;
    const source = manifest.get(`linear_comment:${comment.comment_id}`);
    const current = toFactComment(comment);
    userComments.push(current);
    add(entries, `linear_comment:${comment.comment_id}`, {
      kind: "comment_current_value",
      sourceId: comment.comment_id,
      sourceVersion: source?.source_version ?? comment.remote_version,
      actorKind: source?.actor_kind ?? comment.author_kind,
      observedAt: comment.updated_at,
      comment: current,
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

  const cycles = input.tree.issues
    .filter((issue) => issue.issue_kind === "cycle")
    .map((cycle) => cycleObservation(cycle, input.tree, issues, managedRecords));
  const delivery = managedRecords.find(({ recordKind }) => recordKind === "delivery") ?? noneRecord("delivery");
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
      ownership: noneRecord("root_ownership", rootIssue.remoteVersion),
      convergenceSummary: "Root convergence is governed by durable Linear and Git facts.",
    },
    cycles,
    issues,
    relations,
    managedRecords,
    userComments,
    gitFacts,
    delivery,
    mechanicalViolations: input.mechanicalViolations,
  };
  const sourceManifest = [...entries.values()].map(({ change }) => sourceManifestEntry(change));
  const pendingInputIds = [...entries.values()]
    .filter(({ change }) => change.actorKind !== "symphony" && change.kind !== "git_facts_current_value" && change.kind !== "mechanical_violations_current_value")
    .map(({ change }) => inputId(change.sourceId, change.sourceVersion));
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
    if (before && after && digest(before) === digest(after)) continue;
    if (after) changes.push(after);
    else if (before) changes.push(tombstone(before));
  }
  return {
    baseRootDigest: previous.bootstrap.rootDigest,
    targetRootDigest: current.bootstrap.rootDigest,
    changes,
    pendingInputIds: current.bootstrap.pendingInputIds,
  };
}

function add(entries: Map<string, RootFactEntry>, key: string, change: RootDeltaChange): void {
  entries.set(key, { key, change });
}

function sourceManifestEntry(change: RootDeltaChange): RootSourceManifestEntry {
  const sourceKind = change.kind.startsWith("issue_") ? "linear_issue"
    : change.kind.startsWith("comment_") ? "linear_comment"
      : change.kind.startsWith("relation_") ? "linear_relation"
        : change.kind.startsWith("managed_record_") ? "linear_comment"
        : change.kind === "git_facts_current_value" ? "git" : "linear_issue";
  return { sourceKind, sourceId: change.sourceId, versionOrDigest: change.sourceVersion, actorKind: change.actorKind };
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
    commentVersion: comment.remote_version,
    issueId: comment.issue_id,
    ...(comment.author_user_id ? { authorUserId: comment.author_user_id } : {}),
    authorKind: comment.author_kind,
    body: comment.body,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    ...(comment.managed_marker ? { managedMarker: comment.managed_marker } : {}),
  };
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
  records: RootRecordReference[],
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
  return {
    cycleIssue: toFactIssue(cycle),
    predecessorCycleIssueId: cycle.parent_issue_id ?? "none",
    cycleStatus: cycle.status_name as RootFactIssue["status"],
    isArchived: cycle.is_archived,
    issues: cycleIssues,
    relations: cycleRelations,
    planResults: records.filter((record) => record.recordKind === "stage_result" && cycleIssues.some(({ issueId }) => record.recordId.includes(issueId))),
    workResults: [],
    verifyResults: [],
    findings: [],
    humanActionRecords,
    humanActionResolutions,
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

function recordReference(record: ManagedRecord, version: string): RootRecordReference {
  const identity = "resultId" in record ? record.resultId
    : "resolutionId" in record ? record.resolutionId
      : "rootDirectiveId" in record ? record.rootDirectiveId
      : "actionId" in record ? record.actionId
        : `${record.kind}:${digest(record).slice(0, 24)}`;
  return { recordId: identity, recordKind: record.kind, version };
}

function noneRecord(kind: string, version = "none"): RootRecordReference {
  return { recordId: `none:${kind}`, recordKind: kind, version };
}

function inputId(sourceId: string, sourceVersion: string): string {
  return `${sourceId}:${sourceVersion}`.slice(0, 128);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
