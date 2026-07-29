import type { NativeEffectObservationOutcome } from "../../linear-runtime/api/LinearRootRuntimeInterface.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";
import type { RootStateMechanicalEffect } from "../../root-transition/api/RootStateMechanicalEffect.js";
import type {
  NativeLinearEffectBoundaryInterface,
  RootStateEffectMaterializerInterface,
} from "../api/RootStateEffectMaterializerInterface.js";

export class RootStateEffectMaterializerImpl implements RootStateEffectMaterializerInterface {
  constructor(private readonly linear: NativeLinearEffectBoundaryInterface) {}

  async materialize(
    input: Parameters<RootStateEffectMaterializerInterface["materialize"]>[0],
  ): Promise<NativeEffectObservationOutcome> {
    const { state, effect } = input;
    const root = rootIssue(state);
    if (!root) return { kind: "precondition_failed" };

    const preflight = effect.kind === "create_issue"
      ? createIssuePreflight(state, root, effect)
      : isIssueEffect(effect)
        ? issuePreflight(state, root, effect)
        : commentPreflight(state, effect);
    if (preflight !== "apply") return { kind: preflight };

    const outcome = await this.linear.apply({
      rootIssueId: state.rootIssueId,
      projectId: root.projectId,
      effect,
    });
    if (outcome.kind === "applied") {
      if (effect.kind === "create_issue") {
        const existingIds = new Set(state.observation.facts.flatMap(({ value }) =>
          value.kind === "linear_issue" ? [value.issueId] : []));
        if (outcome.targetIdentity.sourceKind !== "linear_issue" ||
            existingIds.has(outcome.targetIdentity.sourceId)) return { kind: "readback_mismatch" };
      } else {
        const expectedKind = isIssueEffect(effect) ? "linear_issue" : "linear_comment";
        const expectedId = isIssueEffect(effect) ? effect.issueId : effect.commentId;
        if (outcome.targetIdentity.sourceKind !== expectedKind ||
            outcome.targetIdentity.sourceId !== expectedId) return { kind: "readback_mismatch" };
      }
    }
    return outcome;
  }
}

type Preflight = "apply" | "not_applied" | "precondition_failed";
type RootIssue = Extract<RecoveredRootState["observation"]["facts"][number]["value"], { kind: "linear_issue" }>;

function rootIssue(state: RecoveredRootState): RootIssue | undefined {
  const issues = state.observation.facts
    .map(({ value }) => value)
    .filter((value) => value.kind === "linear_issue");
  const roots = issues.filter(({ issueId, issueKind }) => issueId === state.rootIssueId && issueKind === "root");
  const root = roots[0];
  return roots.length === 1 && root && !root.isArchived && root.parentIssueId === undefined ? root : undefined;
}

function issuePreflight(
  state: RecoveredRootState,
  root: RootIssue,
  effect: Extract<RootStateMechanicalEffect, { kind: "set_issue_status" | "update_issue" | "set_issue_archive_state" }>,
): Preflight {
  const issues = state.observation.facts
    .map(({ value }) => value)
    .filter((value) => value.kind === "linear_issue");
  const targets = issues.filter(({ issueId }) => issueId === effect.issueId);
  const target = targets[0];

  if (targets.length !== 1 || !target || target.projectId !== root.projectId) {
    return "precondition_failed";
  }
  if (effect.kind === "set_issue_archive_state") {
    return target.isArchived === effect.isArchived ? "not_applied" : "apply";
  }
  const statuses = state.observation.facts
    .map(({ value }) => value)
    .filter((value) => value.kind === "linear_status" && value.statusId === effect.statusId);
  if (statuses.length !== 1 || target.isArchived) return "precondition_failed";
  if (effect.kind === "update_issue" &&
      (!Number.isFinite(effect.order) || new Set(effect.labelNames).size !== effect.labelNames.length ||
        !effect.labelNames.every((label, index) => index === 0 || compareCodePoints(effect.labelNames[index - 1]!, label) < 0))) {
    return "precondition_failed";
  }
  return isSatisfied(target, effect) ? "not_applied" : "apply";
}

function createIssuePreflight(
  state: RecoveredRootState,
  root: RootIssue,
  effect: Extract<RootStateMechanicalEffect, { kind: "create_issue" }>,
): Preflight {
  const issues = state.observation.facts
    .map(({ value }) => value)
    .filter((value) => value.kind === "linear_issue");
  const parents = issues.filter(({ issueId }) => issueId === effect.parentIssueId);
  const statuses = state.observation.facts
    .map(({ value }) => value)
    .filter((value) => value.kind === "linear_status" && value.statusId === effect.statusId);
  const parent = parents[0];
  if (parents.length !== 1 || statuses.length !== 1 || !parent || parent.isArchived ||
      parent.projectId !== root.projectId || !effect.title.trim() || !effect.description.trim() ||
      new Set(effect.labelNames).size !== effect.labelNames.length ||
      !effect.labelNames.every((label, index) =>
        label.trim().length > 0 && (index === 0 || compareCodePoints(effect.labelNames[index - 1]!, label) < 0))) {
    return "precondition_failed";
  }
  const exact = issues.filter((issue) => !issue.isArchived && issue.parentIssueId === parent.issueId &&
    issue.projectId === root.projectId && issue.statusId === effect.statusId && issue.title === effect.title &&
    issue.description === effect.description && issue.labels.length === effect.labelNames.length &&
    issue.labels.every((label, index) => label === effect.labelNames[index]));
  if (exact.length > 1) return "precondition_failed";
  return exact.length === 1 ? "not_applied" : "apply";
}

function isIssueEffect(
  effect: RootStateMechanicalEffect,
): effect is Extract<RootStateMechanicalEffect, { kind: "set_issue_status" | "update_issue" | "set_issue_archive_state" }> {
  return effect.kind === "set_issue_status" || effect.kind === "update_issue" ||
    effect.kind === "set_issue_archive_state";
}

function commentPreflight(
  state: RecoveredRootState,
  effect: Extract<RootStateMechanicalEffect, { kind: "set_comment_receipt" | "set_comment_thread_state" }>,
): Preflight {
  const comments = state.observation.facts
    .map(({ value }) => value)
    .filter((value) => value.kind === "linear_comment");
  const matches = comments.filter(({ commentId }) => commentId === effect.commentId);
  const comment = matches[0];
  if (matches.length !== 1 || !comment || comment.issueId !== state.rootIssueId ||
      comment.threadRootCommentId !== effect.threadRootCommentId ||
      !comments.some(({ commentId }) => commentId === effect.threadRootCommentId)) {
    return "precondition_failed";
  }
  if (effect.kind === "set_comment_thread_state") {
    return comment.threadState === effect.threadState ? "not_applied" : "apply";
  }
  const receipts = comment.reactions.filter(({ actorKind, emoji }) =>
    actorKind === "symphony" && (emoji === "\u2705" || emoji === "\u274c"));
  if (receipts.length === 0) return "apply";
  return receipts.length === 1 && receipts[0]!.emoji === "\u2705" ? "not_applied" : "precondition_failed";
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0)!);
  const rightPoints = [...right].map((value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

function isSatisfied(
  target: Extract<Parameters<RootStateEffectMaterializerInterface["materialize"]>[0]["state"]["observation"]["facts"][number]["value"], { kind: "linear_issue" }>,
  effect: Extract<RootStateMechanicalEffect, { kind: "set_issue_status" | "update_issue" }>,
): boolean {
  if (target.statusId !== effect.statusId) return false;
  if (effect.kind === "set_issue_status") return true;
  return target.title === effect.title && target.description === effect.description && target.order === effect.order &&
    target.labels.length === effect.labelNames.length &&
    target.labels.every((label, index) => label === effect.labelNames[index]);
}
