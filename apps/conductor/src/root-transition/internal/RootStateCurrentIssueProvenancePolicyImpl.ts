import type {
  RootStateCurrentIssueProof,
  RootStateCurrentIssueProvenancePolicyInterface,
} from "../api/RootStateCurrentIssueProvenancePolicyInterface.js";
import type { RootStateActivity } from "../api/RootStateViewPolicyInterface.js";

type ProveInput = Parameters<RootStateCurrentIssueProvenancePolicyInterface["prove"]>[0];

export class RootStateCurrentIssueProvenancePolicyImpl implements RootStateCurrentIssueProvenancePolicyInterface {
  prove(input: ProveInput): RootStateCurrentIssueProof | undefined {
    const sources = input.view.provenance.filter(({ sourceKind, sourceId }) =>
      sourceKind === "linear_issue" && sourceId === input.issue.issueId);
    if (sources.length !== 1) return undefined;
    if (sources[0]?.actorKind === "symphony") return { kind: "manifest" };
    const creator = input.issue.creatorUserId;
    if (sources[0]?.actorKind !== "unknown" || !creator ||
        (input.expectedActorId !== undefined && creator !== input.expectedActorId)) return undefined;

    const relevant = activities(input);
    const latest = (kind: RootStateActivity["activityKinds"][number]) =>
      relevant.filter(({ activityKinds }) => activityKinds.includes(kind)).at(-1);
    if (input.requiredActivityKinds.some((kind) => latest(kind) === undefined) ||
        (input.requiredActivityKinds.length === 0 && input.expectedActorId === undefined)) return undefined;

    const actorIsCurrent = (activity: RootStateActivity | undefined) =>
      !activity || (activity.actorKind === "symphony" && activity.actorId === creator);
    const status = latest("status_changed");
    const description = latest("description_changed");
    const archive = latest("archive_changed");
    const parent = latest("parent_changed");
    if (!actorIsCurrent(status) || !actorIsCurrent(description) || !actorIsCurrent(archive) ||
        !actorIsCurrent(parent) || (status && status.toStateId !== input.issue.statusId) ||
        (description && description.updatedDescription !== input.issue.description) ||
        (archive && archive.archived !== input.issue.isArchived) ||
        (parent && parent.toParentId !== input.issue.parentIssueId) ||
        relevant.filter(({ activityKinds }) => activityKinds.includes("labels_changed"))
          .some(({ actorKind, actorId }) => actorKind !== "symphony" || actorId !== creator)) return undefined;
    return { kind: "activity", actorId: creator };
  }

  currentStatusActor(
    input: Parameters<RootStateCurrentIssueProvenancePolicyInterface["currentStatusActor"]>[0],
  ): string | undefined {
    const sources = input.view.provenance.filter(({ sourceKind, sourceId }) =>
      sourceKind === "linear_issue" && sourceId === input.issue.issueId);
    if (sources.length !== 1 || sources[0]?.actorKind !== "unknown") return undefined;
    const latest = activities(input)
      .filter(({ activityKinds }) => activityKinds.includes("status_changed")).at(-1);
    return latest?.actorKind === "symphony" && latest.actorId && latest.toStateId === input.issue.statusId
      ? latest.actorId
      : undefined;
  }
}

function activities(input: Pick<ProveInput, "view" | "issue">): RootStateActivity[] {
  return input.view.activities.filter(({ issueId }) => issueId === input.issue.issueId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
      compareCodePoints(left.activityId, right.activityId));
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
