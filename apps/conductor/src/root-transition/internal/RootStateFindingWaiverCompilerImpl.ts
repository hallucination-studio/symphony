import { humanActionScopeFromBody } from "../../human-actions/api/HumanActionScope.js";
import type { RootStateFindingWaiverCompilerInterface } from "../api/RootStateFindingWaiverCompilerInterface.js";
import type { RootStateMechanicalCompilerResult } from "../api/RootStateMechanicalCompilerResult.js";
import type {
  RootStateActivity,
  RootStateComment,
  RootStateIssue,
  RootStateView,
  RootStateViewPolicyInterface,
} from "../api/RootStateViewPolicyInterface.js";

type Input = Parameters<RootStateFindingWaiverCompilerInterface["compile"]>[0];

export class RootStateFindingWaiverCompilerImpl implements RootStateFindingWaiverCompilerInterface {
  constructor(private readonly views: RootStateViewPolicyInterface) {}

  compile(input: Input): RootStateMechanicalCompilerResult {
    let view: RootStateView;
    try {
      view = this.views.derive(input.state);
    } catch (error) {
      if (error instanceof Error && error.message === "recovered_root_state_view_invalid") return invalid("topology_invalid");
      throw error;
    }

    const proof = waiverProof(input, view);
    if (!proof) return invalid("topology_invalid");
    const open = proof.findings.find(({ statusName }) => statusName === "Todo" || statusName === "In Progress");
    if (open) {
      if (receipt(proof.reply) !== "none" || !allThreadStates(proof, "unresolved")) return invalid("topology_invalid");
      const canceled = view.statuses.filter(({ name }) => name === "Canceled");
      return canceled.length === 1
        ? { kind: "effect", effect: { kind: "set_issue_status", issueId: open.issueId, statusId: canceled[0]!.statusId } }
        : invalid("status_catalog_invalid");
    }

    const observedReceipt = receipt(proof.reply);
    if (observedReceipt === "invalid" || observedReceipt === "cross") return invalid("topology_invalid");
    if (observedReceipt === "none") {
      return allThreadStates(proof, "unresolved")
        ? { kind: "effect", effect: {
            kind: "set_comment_receipt", commentId: proof.reply.commentId,
            threadRootCommentId: proof.request.commentId, receipt: "check",
          } }
        : invalid("topology_invalid");
    }
    if (proof.reply.threadState === "unresolved") {
      return proof.request.threadState === "unresolved" && proof.adoption.threadState === "unresolved"
        ? { kind: "effect", effect: {
            kind: "set_comment_thread_state", commentId: proof.reply.commentId,
            threadRootCommentId: proof.request.commentId, threadState: "resolved",
          } }
        : invalid("topology_invalid");
    }
    return proof.request.threadState === "resolved" && proof.adoption.threadState === "resolved"
      ? { kind: "satisfied" }
      : invalid("topology_invalid");
  }
}

function waiverProof(input: Input, view: RootStateView): {
  request: RootStateComment;
  reply: RootStateComment;
  adoption: RootStateComment;
  findings: RootStateIssue[];
} | undefined {
  const { root } = view;
  const cycle = unique(view.issues.filter(({ issueId }) => issueId === input.cycleIssueId));
  if (root.isArchived || root.parentIssueId !== undefined || !cycle || cycle.issueKind !== "cycle" ||
      cycle.parentIssueId !== root.issueId || cycle.projectId !== root.projectId || cycle.isArchived ||
      cycle.statusName !== "Verifying") return undefined;

  const children = view.issues.filter(({ parentIssueId, isArchived }) => parentIssueId === cycle.issueId && !isArchived);
  const plans = children.filter(({ issueKind }) => issueKind === "plan");
  const works = children.filter(({ issueKind }) => issueKind === "work");
  const verifies = children.filter(({ issueKind }) => issueKind === "verify");
  const verify = verifies[0];
  if (plans.length !== 1 || plans[0]?.statusName !== "Done" || works.length === 0 ||
      works.some(({ statusName }) => statusName !== "Done") || verifies.length !== 1 || !verify ||
      verify.statusName !== "Done" || !verify.labels.includes("Changes Required") ||
      !verify.description.split("\n").includes("Verify Changes Required.")) return undefined;

  const request = unique(view.comments.filter(({ commentId }) => commentId === input.requestCommentId));
  const reply = unique(view.comments.filter(({ commentId }) => commentId === input.humanReplyCommentId));
  const adoption = unique(view.comments.filter(({ commentId }) => commentId === input.adoptionCommentId));
  if (!request || !reply || !adoption || request.issueId !== root.issueId || request.authorKind !== "symphony" ||
      request.parentCommentId !== undefined || request.threadRootCommentId !== request.commentId ||
      request.body.split("\n", 1)[0] !== "## 需要你确认 Finding 豁免" ||
      reply.issueId !== root.issueId || reply.authorKind !== "human" || !reply.authorUserId ||
      reply.authorId !== reply.authorUserId ||
      (reply.authorUserId !== root.creatorUserId && reply.authorUserId !== root.assigneeUserId) ||
      reply.parentCommentId !== request.commentId || reply.threadRootCommentId !== request.commentId ||
      adoption.issueId !== root.issueId || adoption.authorKind !== "symphony" ||
      adoption.parentCommentId !== reply.commentId || adoption.threadRootCommentId !== request.commentId ||
      !adoption.body.startsWith("## 已应用\n\n") || !atOrAfter(adoption.createdAt, reply.updatedAt) ||
      !currentComment(view, request, "symphony") || !currentComment(view, reply, "human") ||
      !currentComment(view, adoption, "symphony") ||
      view.comments.filter((comment) => comment.authorKind === "symphony" &&
        comment.parentCommentId === reply.commentId && comment.threadRootCommentId === request.commentId &&
        comment.body.startsWith("## 已应用\n\n")).length !== 1) return undefined;

  const findingIds = [...input.findingIssueIds].sort(compareCodePoints);
  if (findingIds.length === 0 || new Set(findingIds).size !== findingIds.length) return undefined;
  const findings = findingIds.map((issueId) => unique(children.filter((issue) => issue.issueId === issueId && issue.issueKind === "finding")));
  if (findings.some((finding) => !finding)) return undefined;
  const exact = findings as RootStateIssue[];
  const scope = humanActionScopeFromBody(request.body);
  if (!scope || !sameSet(scope.targetIdentifiers, exact.map(({ identifier }) => identifier)) ||
      !sameSet(scope.contextIdentifiers, [verify.identifier, cycle.identifier]) ||
      exact.some((finding) => !["Todo", "In Progress", "Canceled"].includes(finding.statusName) ||
        !currentIssue(view, finding, finding.statusName === "Canceled" ? ["status_changed"] : []))) return undefined;

  const exactIds = new Set(exact.map(({ issueId }) => issueId));
  if (children.some(({ issueKind, statusName, issueId }) => issueKind === "finding" &&
      (statusName === "Todo" || statusName === "In Progress") && !exactIds.has(issueId))) return undefined;
  const relations = view.relations.filter(({ sourceIssueId, targetIssueId }) =>
    exactIds.has(sourceIssueId) || exactIds.has(targetIssueId));
  if (relations.some(({ relationKind, sourceIssueId, targetIssueId }) =>
      relationKind !== "relates_to" || !exactIds.has(sourceIssueId) || targetIssueId !== verify.issueId) ||
      exact.some(({ issueId }) => !relations.some(({ sourceIssueId, targetIssueId }) =>
        sourceIssueId === issueId && targetIssueId === verify.issueId)) || duplicateRelations(relations)) return undefined;
  return { request, reply, adoption, findings: exact };
}

function currentComment(view: RootStateView, comment: RootStateComment, actorKind: "human" | "symphony"): boolean {
  const sources = view.provenance.filter(({ sourceKind, sourceId }) =>
    sourceKind === "linear_comment" && sourceId === comment.commentId);
  return sources.length === 1 && sources[0]?.actorKind === actorKind;
}

function currentIssue(
  view: RootStateView,
  issue: RootStateIssue,
  requiredKinds: readonly RootStateActivity["activityKinds"][number][],
): boolean {
  const sources = view.provenance.filter(({ sourceKind, sourceId }) =>
    sourceKind === "linear_issue" && sourceId === issue.issueId);
  if (sources.length !== 1) return false;
  if (sources[0]?.actorKind === "symphony") return true;
  if (sources[0]?.actorKind !== "unknown" || !issue.creatorUserId) return false;

  const activities = view.activities.filter(({ issueId }) => issueId === issue.issueId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.activityId.localeCompare(right.activityId));
  const latest = (kind: RootStateActivity["activityKinds"][number]) =>
    activities.filter(({ activityKinds }) => activityKinds.includes(kind)).at(-1);
  if (requiredKinds.some((kind) => latest(kind) === undefined) || requiredKinds.length === 0) return false;
  const actorIsCurrent = (activity: (typeof activities)[number] | undefined) =>
    !activity || (activity.actorKind === "symphony" && activity.actorId === issue.creatorUserId);
  const status = latest("status_changed");
  const description = latest("description_changed");
  const archive = latest("archive_changed");
  const parent = latest("parent_changed");
  if (!actorIsCurrent(status) || !actorIsCurrent(description) || !actorIsCurrent(archive) || !actorIsCurrent(parent) ||
      (status && status.toStateId !== issue.statusId) ||
      (description && description.updatedDescription !== issue.description) ||
      (archive && archive.archived !== issue.isArchived) || (parent && parent.toParentId !== issue.parentIssueId)) return false;
  return activities.filter(({ activityKinds }) => activityKinds.includes("labels_changed"))
    .every(({ actorKind, actorId }) => actorKind === "symphony" && actorId === issue.creatorUserId);
}

function receipt(comment: RootStateComment): "none" | "check" | "cross" | "invalid" {
  const values = comment.reactions.filter(({ actorKind, emoji }) =>
    actorKind === "symphony" && (emoji === "✅" || emoji === "❌"));
  if (values.length === 0) return "none";
  if (values.length !== 1) return "invalid";
  return values[0]!.emoji === "✅" ? "check" : "cross";
}

function allThreadStates(proof: { request: RootStateComment; reply: RootStateComment; adoption: RootStateComment }, state: "unresolved"): boolean {
  return proof.request.threadState === state && proof.reply.threadState === state && proof.adoption.threadState === state;
}

function unique<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

function atOrAfter(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime >= rightTime;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort(compareCodePoints)
    .every((value, index) => value === [...right].sort(compareCodePoints)[index]);
}

function duplicateRelations(relations: RootStateView["relations"]): boolean {
  const keys = relations.map(({ relationKind, sourceIssueId, targetIssueId }) =>
    `${relationKind}\0${sourceIssueId}\0${targetIssueId}`);
  return new Set(keys).size !== keys.length;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootStateMechanicalCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootStateMechanicalCompilerResult {
  return { kind: "invalid_facts", reason };
}
