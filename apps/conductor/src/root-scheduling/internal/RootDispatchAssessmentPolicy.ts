import type {
  RootDispatchAssessment,
  V3RootRunView,
} from "../../root-workflow/api/Models.js";

const problemReasons = {
  ownership_conflict: "root_ownership_conflict",
  project_resolution_changed: "root_project_resolution_changed",
  tree_conflict: "root_tree_conflict",
  git_identity_conflict: "root_git_identity_conflict",
  facts_changed: "root_facts_changed",
} as const;

export function assessRootDispatch(view: V3RootRunView): RootDispatchAssessment {
  const base = { rootIssueId: view.root.issueId };
  if (view.root.state === "Done" || view.root.state === "Canceled") {
    return { ...base, readiness: "terminal" };
  }
  if (view.root.state === "In Review" && !hasActionableNode(view)) {
    return { ...base, readiness: "terminal" };
  }
  if (!view.workflowTreeComplete) {
    return attention(base, "root_tree_incomplete");
  }
  if (view.blockerRelations.some((relation) =>
    relation.sourceIssueId === view.root.issueId
      && relation.targetState !== "Done"
      && relation.targetState !== "Canceled")) {
    return attention(base, "root_blocked");
  }
  const problem = view.attentionProblems[0];
  if (problem) {
    return {
      ...base,
      readiness: "needs_attention",
      sanitizedReason: problemReasons[problem],
    };
  }
  const managed = view.managedComment;
  if (!managed) {
    if (view.root.state !== "Todo") {
      return attention(base, "root_managed_comment_missing");
    }
    return view.profile?.readiness === "ready"
      ? { ...base, readiness: "runnable" }
      : attention(base, "performer_profile_not_ready");
  }
  if (managed.conductorId !== view.conductorId) {
    return attention(base, "root_ownership_conflict");
  }
  if (!view.profile || view.profile.profileId !== managed.performerProfileId) {
    return attention(base, "performer_profile_missing");
  }
  if (view.profile.readiness !== "ready") {
    return attention(base, "performer_profile_not_ready");
  }
  if (managed.retryBlock) {
    if (managed.retryBlock.expectedPerformerId !== managed.performerId) {
      return attention(base, "root_retry_pointer_conflict");
    }
    return attention(base, "root_retry_blocked");
  }
  const activeNodes = nonCanceledNodes(view);
  const activeAgentWork = activeNodes.filter((node) =>
    node.kind === "work" && node.origin === "symphony"
      && node.state === "In Progress");
  if (activeAgentWork.length > 1) {
    return attention(base, "multiple_active_work_nodes");
  }
  if (activeNodes.some((node) =>
    node.kind === "human" && node.state === "In Progress")) {
    return { ...base, readiness: "waiting_human" };
  }
  return { ...base, readiness: "runnable" };
}

function attention(
  base: { rootIssueId: string },
  sanitizedReason: string,
): RootDispatchAssessment {
  return { ...base, readiness: "needs_attention", sanitizedReason };
}

function hasActionableNode(view: V3RootRunView): boolean {
  return nonCanceledNodes(view).some((node) =>
    node.state === "Todo" || node.state === "In Progress");
}

function nonCanceledNodes(view: V3RootRunView) {
  const byId = new Map(view.workflowNodes.map((node) => [node.issueId, node]));
  return view.workflowNodes.filter((node) => {
    if (node.state === "Canceled") return false;
    let parentIssueId = node.parentIssueId;
    const visited = new Set<string>();
    while (parentIssueId && parentIssueId !== view.root.issueId) {
      if (visited.has(parentIssueId)) return false;
      visited.add(parentIssueId);
      const parent = byId.get(parentIssueId);
      if (!parent) return false;
      if (parent.state === "Canceled") return false;
      parentIssueId = parent.parentIssueId;
    }
    return true;
  });
}
