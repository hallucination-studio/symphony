import { isDeepStrictEqual } from "node:util";

import { humanActionRequestScope } from "../../human-actions/api/HumanActionSummary.js";
import type { LinearWorkflowTreeSnapshot } from "../../linear-gateway/api/LinearGatewayInterface.js";
import type { RootReconciliationView } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { currentWorkflowIssueProof } from "../../root-reconciliation/internal/CurrentIssueProvenance.js";
import type { RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, { kind: "converge_finding_waiver" }>;
type Issue = LinearWorkflowTreeSnapshot["issues"][number];

export class FindingWaiverCompilerImpl {
  compile(input: { target: Target; view: RootReconciliationView }): RootMechanicalConvergenceCompilerResult {
    const { target, view } = input;
    if (!isDeepStrictEqual(target.expectedWorktreeGate, view.worktreeGate)) return invalid("target_stale");
    const proof = waiverProof(target, view);
    if (!proof) return invalid("topology_invalid");
    const { root, request, reply, adoption, findings } = proof;
    const open = findings.find(({ status_name }) => status_name === "Todo" || status_name === "In Progress");
    if (open) {
      if (receipt(reply) !== "none" || request.thread_state !== "unresolved" ||
          reply.thread_state !== "unresolved" || adoption.thread_state !== "unresolved") return invalid("topology_invalid");
      const canceled = view.tree.status_catalog.filter(({ name }) => name === "Canceled");
      if (canceled.length !== 1) return invalid("status_catalog_invalid");
      return {
        kind: "effect",
        command: {
          kind: "update_workflow_issue",
          writeId: mechanicalWriteId([root.issue_id, request.comment_id, reply.comment_id, adoption.comment_id, open.issue_id, "finding-waiver"]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          target: {
            targetIssueId: open.issue_id,
            expectedRemoteVersion: open.remote_version,
            expectedStatusId: open.status_id,
            expectedParentIssueId: target.cycleIssueId,
            expectedIsArchived: false,
          },
          statusId: canceled[0]!.status_id,
          title: open.title,
          description: open.description,
          labelNames: open.labels,
          parentAssignment: { mode: "retain" },
          order: open.order,
        },
      };
    }

    const observedReceipt = receipt(reply);
    if (observedReceipt === "invalid" || observedReceipt === "cross") return invalid("topology_invalid");
    if (observedReceipt === "none") {
      if (request.thread_state !== "unresolved" || reply.thread_state !== "unresolved" ||
          adoption.thread_state !== "unresolved") return invalid("topology_invalid");
      const replyWriteId = adoptionWriteId(root, reply, adoption);
      return {
        kind: "effect",
        command: {
          kind: "create_comment_receipt_reaction",
          writeId: `${replyWriteId}:receipt-create`,
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          replyWriteId,
          sourceCommentId: reply.comment_id,
          expectedSourceCommentRemoteVersion: reply.remote_version,
          threadRootCommentId: request.comment_id,
          receipt: "check",
        },
      };
    }
    if (reply.thread_state === "unresolved") {
      if (request.thread_state !== "unresolved" || adoption.thread_state !== "unresolved") return invalid("topology_invalid");
      const replyWriteId = adoptionWriteId(root, reply, adoption);
      return {
        kind: "effect",
        command: {
          kind: "set_comment_thread_state",
          writeId: `${replyWriteId}:thread-state`,
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          replyWriteId,
          sourceCommentId: reply.comment_id,
          expectedSourceCommentRemoteVersion: reply.remote_version,
          threadRootCommentId: request.comment_id,
          expectedThreadState: "unresolved",
          threadState: "resolved",
        },
      };
    }
    return request.thread_state === "resolved" && adoption.thread_state === "resolved"
      ? { kind: "satisfied" }
      : invalid("topology_invalid");
  }
}

function waiverProof(target: Target, view: RootReconciliationView): {
  root: Issue;
  request: LinearWorkflowTreeSnapshot["comments"][number];
  reply: LinearWorkflowTreeSnapshot["comments"][number];
  adoption: LinearWorkflowTreeSnapshot["comments"][number];
  findings: Issue[];
} | undefined {
  const { tree } = view;
  if (!tree.coverage.is_complete || tree.coverage.omissions.length > 0) return undefined;
  const root = tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
  const cycle = tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
  if (!root || tree.root_issue_id !== root.issue_id || root.issue_kind !== "root" || root.is_archived ||
      root.parent_issue_id !== undefined || root.project_id !== view.root.projectId ||
      !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
      cycle.status_name !== "Verifying") return undefined;
  const children = tree.issues.filter(({ parent_issue_id, is_archived }) => parent_issue_id === cycle.issue_id && !is_archived);
  const plans = children.filter(({ issue_kind }) => issue_kind === "plan");
  const works = children.filter(({ issue_kind }) => issue_kind === "work");
  const verifies = children.filter(({ issue_kind }) => issue_kind === "verify");
  const verify = verifies[0];
  if (plans.length !== 1 || plans[0]?.status_name !== "Done" || works.length === 0 ||
      works.some(({ status_name }) => status_name !== "Done") || verifies.length !== 1 ||
      !verify || verify.status_name !== "Done" || !verify.labels.includes("Changes Required") ||
      !verify.description.split("\n").includes("Verify Changes Required.")) return undefined;

  const request = tree.comments.find(({ comment_id }) => comment_id === target.requestCommentId);
  const reply = tree.comments.find(({ comment_id }) => comment_id === target.humanReplyCommentId);
  const adoption = tree.comments.find(({ comment_id }) => comment_id === target.adoptionCommentId);
  if (!request || !reply || !adoption || request.issue_id !== root.issue_id ||
      request.author_kind !== "symphony" || request.parent_comment_id !== undefined ||
      request.thread_root_comment_id !== request.comment_id || request.body.split("\n", 1)[0] !== "## 需要你确认 Finding 豁免" ||
      reply.issue_id !== root.issue_id || reply.author_kind !== "human" || !reply.author_user_id ||
      reply.author_id !== reply.author_user_id || (reply.author_user_id !== root.creator_user_id && reply.author_user_id !== root.assignee_user_id) ||
      reply.parent_comment_id !== request.comment_id || reply.thread_root_comment_id !== request.comment_id ||
      adoption.issue_id !== root.issue_id || adoption.author_kind !== "symphony" ||
      adoption.parent_comment_id !== reply.comment_id || adoption.thread_root_comment_id !== request.comment_id ||
      !adoption.body.startsWith("## 已应用\n\n") || adoption.created_at < reply.updated_at ||
      !currentComment(tree, request, "symphony") || !currentComment(tree, reply, "human") ||
      !currentComment(tree, adoption, "symphony") ||
      tree.comments.filter(({ author_kind, parent_comment_id, thread_root_comment_id, body }) =>
        author_kind === "symphony" && parent_comment_id === reply.comment_id &&
        thread_root_comment_id === request.comment_id && body.startsWith("## 已应用\n\n")).length !== 1) return undefined;

  const scope = humanActionRequestScope(request);
  const findingIds = [...target.findingIssueIds].sort();
  const findings = findingIds.map((id) => children.find(({ issue_id, issue_kind }) => issue_id === id && issue_kind === "finding"));
  if (!scope || findings.some((finding) => !finding) || new Set(findingIds).size !== findingIds.length ||
      !sameSet(scope.targetIdentifiers, findings.map((finding) => finding!.identifier)) ||
      !sameSet(scope.contextIdentifiers, [verify.identifier, cycle.identifier])) return undefined;
  const exact = findings.map((finding) => finding!);
  if (exact.some((finding) => !["Todo", "In Progress", "Canceled"].includes(finding.status_name) ||
      !currentWorkflowIssueProof({ tree, issue: finding, requiredActivityKinds: finding.status_name === "Canceled" ? ["status_changed"] : [] }))) return undefined;
  const exactIds = new Set(exact.map(({ issue_id }) => issue_id));
  if (children.some(({ issue_kind, status_name, issue_id }) => issue_kind === "finding" &&
      ["Todo", "In Progress"].includes(status_name) && !exactIds.has(issue_id))) return undefined;
  const allowedTargets = new Set([verify.issue_id, ...works.map(({ issue_id }) => issue_id)]);
  const relations = tree.relations.filter(({ source_issue_id, target_issue_id }) =>
    exactIds.has(source_issue_id) || exactIds.has(target_issue_id));
  if (relations.some(({ relation_kind, source_issue_id, target_issue_id }) =>
      relation_kind !== "relates_to" || !exactIds.has(source_issue_id) || !allowedTargets.has(target_issue_id)) ||
      exact.some(({ issue_id }) => !relations.some(({ source_issue_id, target_issue_id }) =>
        source_issue_id === issue_id && target_issue_id === verify.issue_id)) || duplicateRelations(relations)) return undefined;
  return { root, request, reply, adoption, findings: exact };
}

function currentComment(tree: LinearWorkflowTreeSnapshot, comment: LinearWorkflowTreeSnapshot["comments"][number], actorKind: "human" | "symphony"): boolean {
  return tree.source_manifest.some(({ source_kind, source_id, source_version, actor_kind }) =>
    source_kind === "linear_comment" && source_id === comment.comment_id &&
    source_version === comment.remote_version && actor_kind === actorKind);
}

function receipt(comment: LinearWorkflowTreeSnapshot["comments"][number]): "none" | "check" | "cross" | "invalid" {
  const values = comment.reactions.filter(({ actor_kind, emoji }) => actor_kind === "symphony" && (emoji === "✅" || emoji === "❌"));
  if (values.length === 0) return "none";
  if (values.length !== 1) return "invalid";
  return values[0]!.emoji === "✅" ? "check" : "cross";
}

function adoptionWriteId(root: Issue, reply: LinearWorkflowTreeSnapshot["comments"][number], adoption: LinearWorkflowTreeSnapshot["comments"][number]): string {
  return mechanicalWriteId([root.issue_id, reply.comment_id, reply.remote_version, adoption.comment_id, "finding-waiver-adoption"]);
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function duplicateRelations(relations: LinearWorkflowTreeSnapshot["relations"]): boolean {
  const keys = relations.map(({ relation_kind, source_issue_id, target_issue_id }) => `${relation_kind}\0${source_issue_id}\0${target_issue_id}`);
  return new Set(keys).size !== keys.length;
}

function invalid(reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"]): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
