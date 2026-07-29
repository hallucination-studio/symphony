import type {
  CanonicalFact,
  CanonicalFactIdentity,
  CanonicalFactInput,
  CanonicalFactValue,
  CanonicalObservation,
} from "../api/CanonicalFact.js";
import type { CanonicalObservationPolicyInterface } from "../api/CanonicalObservationPolicyInterface.js";

export class CanonicalObservationPolicyImpl implements CanonicalObservationPolicyInterface {
  canonicalize(inputs: readonly CanonicalFactInput[]): CanonicalObservation {
    const facts = inputs.map(canonicalFact).sort((left, right) => compareIdentity(left.identity, right.identity));
    for (let index = 1; index < facts.length; index += 1) {
      const current = facts[index]!;
      const previous = facts[index - 1]!;
      if (compareIdentity(previous.identity, current.identity) === 0) {
        throw new Error(`canonical_fact_identity_duplicate:${current.identity.sourceKind}:${current.identity.sourceId}`);
      }
    }
    return deepFreeze({ facts });
  }
}

function canonicalFact(input: CanonicalFactInput): CanonicalFact {
  const value = canonicalValue(input.value);
  return {
    identity: identityFor(value),
    value,
    provenance: {
      actorKind: input.provenance.actorKind,
      observedAt: input.provenance.observedAt,
    },
  };
}

function canonicalValue(value: CanonicalFactValue): CanonicalFactValue {
  switch (value.kind) {
    case "linear_status":
    case "linear_relation":
    case "linear_attachment":
      return { ...value };
    case "linear_issue":
      return {
        kind: value.kind,
        issueId: value.issueId,
        identifier: value.identifier,
        projectId: value.projectId,
        ...(value.parentIssueId === undefined ? {} : { parentIssueId: value.parentIssueId }),
        ...(value.creatorUserId === undefined ? {} : { creatorUserId: value.creatorUserId }),
        ...(value.assigneeUserId === undefined ? {} : { assigneeUserId: value.assigneeUserId }),
        statusId: value.statusId,
        statusName: value.statusName,
        statusCategory: value.statusCategory,
        statusPosition: value.statusPosition,
        order: value.order,
        depth: value.depth,
        title: value.title,
        description: value.description,
        labels: sorted(value.labels),
        isArchived: value.isArchived,
        ...(value.issueKind === undefined ? {} : { issueKind: value.issueKind }),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      };
    case "linear_comment":
      return {
        kind: value.kind,
        commentId: value.commentId,
        issueId: value.issueId,
        body: value.body,
        authorKind: value.authorKind,
        authorId: value.authorId,
        ...(value.authorUserId === undefined ? {} : { authorUserId: value.authorUserId }),
        ...(value.parentCommentId === undefined ? {} : { parentCommentId: value.parentCommentId }),
        threadRootCommentId: value.threadRootCommentId,
        threadState: value.threadState,
        reactions: [...value.reactions]
          .map((reaction) => ({ ...reaction }))
          .sort((left, right) => compareCodePoints(left.reactionId, right.reactionId)),
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
      };
    case "linear_activity":
      return {
        kind: value.kind,
        activityId: value.activityId,
        issueId: value.issueId,
        activityKinds: sorted(value.activityKinds),
        actorKind: value.actorKind,
        ...(value.actorId === undefined ? {} : { actorId: value.actorId }),
        ...(value.fromStateId === undefined ? {} : { fromStateId: value.fromStateId }),
        ...(value.toStateId === undefined ? {} : { toStateId: value.toStateId }),
        ...(value.updatedDescription === undefined ? {} : { updatedDescription: value.updatedDescription }),
        ...(value.archived === undefined ? {} : { archived: value.archived }),
        ...(value.addedLabelIds === undefined ? {} : { addedLabelIds: sorted(value.addedLabelIds) }),
        ...(value.removedLabelIds === undefined ? {} : { removedLabelIds: sorted(value.removedLabelIds) }),
        ...(value.fromParentId === undefined ? {} : { fromParentId: value.fromParentId }),
        ...(value.toParentId === undefined ? {} : { toParentId: value.toParentId }),
        ...(value.fromDelegateId === undefined ? {} : { fromDelegateId: value.fromDelegateId }),
        ...(value.toDelegateId === undefined ? {} : { toDelegateId: value.toDelegateId }),
        ...(value.attachmentId === undefined ? {} : { attachmentId: value.attachmentId }),
        createdAt: value.createdAt,
      };
    case "git_worktree":
      return { ...value, changedPaths: sorted(value.changedPaths) };
    default:
      throw new Error(`canonical_fact_kind_unsupported:${String((value as { kind?: unknown }).kind)}`);
  }
}

function identityFor(value: CanonicalFactValue): CanonicalFactIdentity {
  switch (value.kind) {
    case "linear_status": return { sourceKind: value.kind, sourceId: value.statusId };
    case "linear_issue": return { sourceKind: value.kind, sourceId: value.issueId };
    case "linear_comment": return { sourceKind: value.kind, sourceId: value.commentId };
    case "linear_relation": return { sourceKind: value.kind, sourceId: value.relationId };
    case "linear_attachment": return { sourceKind: value.kind, sourceId: value.attachmentId };
    case "linear_activity": return { sourceKind: value.kind, sourceId: value.activityId };
    case "git_worktree": return { sourceKind: value.kind, sourceId: value.rootIssueId };
  }
}

function compareIdentity(left: CanonicalFactIdentity, right: CanonicalFactIdentity): number {
  return compareCodePoints(`${left.sourceKind}:${left.sourceId}`, `${right.sourceKind}:${right.sourceId}`);
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function sorted<T extends string>(values: readonly T[]): T[] {
  return [...values].sort(compareCodePoints);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
