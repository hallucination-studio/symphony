import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type {
  RootActivityFact,
  RootBootstrap,
  RootFactIssue,
} from "../api/RootReconciliationContracts.js";

export type CurrentIssueProof = { kind: "manifest" } | { kind: "activity"; actorId: string };

type CurrentIssue = {
  issueId: string;
  creatorUserId: string | undefined;
  statusId: string | undefined;
  description: string;
  isArchived: boolean;
  parentIssueId: string | undefined;
};

type CurrentActivity = {
  activityId: string;
  issueId: string;
  activityKinds: RootActivityFact["activityKinds"];
  actorKind: RootActivityFact["actorKind"];
  actorId: string | undefined;
  toStateId: string | undefined;
  updatedDescription: string | undefined;
  archived: boolean | undefined;
  toParentId: string | undefined;
  createdAt: string;
};

export function currentFactIssueProof(input: {
  facts: RootBootstrap;
  issue: RootFactIssue;
  requiredActivityKinds: RootActivityFact["activityKinds"];
  expectedActorId?: string;
}): CurrentIssueProof | undefined {
  const source = input.facts.sourceManifest.find(({ sourceKind, sourceId, sourceVersionOrDigest }) =>
    sourceKind === "issue" && sourceId === input.issue.issueId &&
    sourceVersionOrDigest === input.issue.remoteVersion);
  return currentIssueProof({
    sourceActorKind: source?.actorKind,
    coverageComplete: input.facts.coverage.isComplete,
    issue: normalizeFactIssue(input.issue),
    activities: input.facts.rootSnapshot.activities.map(normalizeFactActivity),
    requiredActivityKinds: input.requiredActivityKinds,
    expectedActorId: input.expectedActorId,
  });
}

export function currentWorkflowIssueProof(input: {
  tree: LinearWorkflowTreeSnapshot;
  issue: LinearWorkflowTreeSnapshot["issues"][number];
  requiredActivityKinds: RootActivityFact["activityKinds"];
  expectedActorId?: string;
}): CurrentIssueProof | undefined {
  const source = input.tree.source_manifest.find(({ source_kind, source_id, source_version }) =>
    source_kind === "linear_issue" && source_id === input.issue.issue_id &&
    source_version === input.issue.remote_version);
  return currentIssueProof({
    sourceActorKind: source?.actor_kind,
    coverageComplete: input.tree.coverage.is_complete,
    issue: {
      issueId: input.issue.issue_id,
      creatorUserId: input.issue.creator_user_id,
      statusId: input.issue.status_id,
      description: input.issue.description,
      isArchived: input.issue.is_archived,
      parentIssueId: input.issue.parent_issue_id,
    },
    activities: input.tree.activities.map((activity) => ({
      activityId: activity.activity_id,
      issueId: activity.issue_id,
      activityKinds: activity.activity_kinds,
      actorKind: activity.actor_kind,
      actorId: activity.actor_id,
      toStateId: activity.to_state_id,
      updatedDescription: activity.updated_description,
      archived: activity.archived,
      toParentId: activity.to_parent_id,
      createdAt: activity.created_at,
    })),
    requiredActivityKinds: input.requiredActivityKinds,
    expectedActorId: input.expectedActorId,
  });
}

export function currentFactStatusActor(input: {
  facts: RootBootstrap;
  issue: RootFactIssue;
}): string | undefined {
  const source = input.facts.sourceManifest.find(({ sourceKind, sourceId, sourceVersionOrDigest }) =>
    sourceKind === "issue" && sourceId === input.issue.issueId &&
    sourceVersionOrDigest === input.issue.remoteVersion);
  return currentStatusActor({
    sourceActorKind: source?.actorKind,
    coverageComplete: input.facts.coverage.isComplete,
    issueId: input.issue.issueId,
    statusId: input.issue.statusId,
    activities: input.facts.rootSnapshot.activities.map(normalizeFactActivity),
  });
}

export function currentWorkflowStatusActor(input: {
  tree: LinearWorkflowTreeSnapshot;
  issue: LinearWorkflowTreeSnapshot["issues"][number];
}): string | undefined {
  const source = input.tree.source_manifest.find(({ source_kind, source_id, source_version }) =>
    source_kind === "linear_issue" && source_id === input.issue.issue_id &&
    source_version === input.issue.remote_version);
  return currentStatusActor({
    sourceActorKind: source?.actor_kind,
    coverageComplete: input.tree.coverage.is_complete,
    issueId: input.issue.issue_id,
    statusId: input.issue.status_id,
    activities: input.tree.activities.map((activity) => ({
      activityId: activity.activity_id,
      issueId: activity.issue_id,
      activityKinds: activity.activity_kinds,
      actorKind: activity.actor_kind,
      actorId: activity.actor_id,
      toStateId: activity.to_state_id,
      updatedDescription: activity.updated_description,
      archived: activity.archived,
      toParentId: activity.to_parent_id,
      createdAt: activity.created_at,
    })),
  });
}

function currentIssueProof(input: {
  sourceActorKind: "human" | "symphony" | "linear_integration" | "external_automation" | "unknown" | undefined;
  coverageComplete: boolean;
  issue: CurrentIssue;
  activities: CurrentActivity[];
  requiredActivityKinds: RootActivityFact["activityKinds"];
  expectedActorId: string | undefined;
}): CurrentIssueProof | undefined {
  if (input.sourceActorKind === "symphony") return { kind: "manifest" };
  const creator = input.issue.creatorUserId;
  if (input.sourceActorKind !== "unknown" || !input.coverageComplete || !creator ||
      (input.expectedActorId !== undefined && creator !== input.expectedActorId)) return undefined;

  const relevant = input.activities
    .filter(({ issueId }) => issueId === input.issue.issueId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.activityId.localeCompare(right.activityId));
  const latest = (kind: RootActivityFact["activityKinds"][number]) =>
    relevant.filter(({ activityKinds }) => activityKinds.includes(kind)).at(-1);
  if (input.requiredActivityKinds.some((kind) => latest(kind) === undefined) ||
      (input.requiredActivityKinds.length === 0 && input.expectedActorId === undefined)) return undefined;

  const actorIsCurrent = (activity: (typeof relevant)[number] | undefined) =>
    !activity || (activity.actorKind === "symphony" && activity.actorId === creator);
  const status = latest("status_changed");
  const description = latest("description_changed");
  if (!actorIsCurrent(status) || !actorIsCurrent(description) ||
      (status && (!input.issue.statusId || status.toStateId !== input.issue.statusId)) ||
      (description && description.updatedDescription !== input.issue.description)) return undefined;

  const labels = relevant.filter(({ activityKinds }) => activityKinds.includes("labels_changed"));
  if (labels.some(({ actorKind, actorId }) => actorKind !== "symphony" || actorId !== creator)) return undefined;
  const archive = latest("archive_changed");
  const parent = latest("parent_changed");
  if (!actorIsCurrent(archive) || (archive && archive.archived !== input.issue.isArchived) ||
      !actorIsCurrent(parent) || (parent && parent.toParentId !== input.issue.parentIssueId)) return undefined;
  return { kind: "activity", actorId: creator };
}

function currentStatusActor(input: {
  sourceActorKind: RootActivityFact["actorKind"] | undefined;
  coverageComplete: boolean;
  issueId: string;
  statusId: string | undefined;
  activities: CurrentActivity[];
}): string | undefined {
  if (input.sourceActorKind !== "unknown" || !input.coverageComplete || !input.statusId) return undefined;
  const latest = input.activities
    .filter(({ issueId, activityKinds }) => issueId === input.issueId && activityKinds.includes("status_changed"))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.activityId.localeCompare(right.activityId))
    .at(-1);
  return latest?.actorKind === "symphony" && latest.actorId && latest.toStateId === input.statusId
    ? latest.actorId
    : undefined;
}

function normalizeFactIssue(issue: RootFactIssue): CurrentIssue {
  return {
    issueId: issue.issueId,
    creatorUserId: issue.creatorUserId,
    statusId: issue.statusId,
    description: issue.description,
    isArchived: issue.isArchived,
    parentIssueId: issue.parentIssueId,
  };
}

function normalizeFactActivity(activity: RootActivityFact): CurrentActivity {
  return {
    activityId: activity.activityId,
    issueId: activity.issueId,
    activityKinds: activity.activityKinds,
    actorKind: activity.actorKind,
    actorId: activity.actorId,
    toStateId: activity.toStateId,
    updatedDescription: activity.updatedDescription,
    archived: activity.archived,
    toParentId: activity.toParentId,
    createdAt: activity.createdAt,
  };
}
