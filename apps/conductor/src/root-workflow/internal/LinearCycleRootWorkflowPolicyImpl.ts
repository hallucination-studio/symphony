import type {
  RootDagView,
  RootCycleView,
  RootDispatchAssessment,
  RootWorkflowPolicyInterface,
} from "../api/RootWorkflowPolicyInterface.js";

const terminalRootStates = new Set(["Done", "Canceled"]);
const terminalCycleStates = new Set(["Succeeded", "Changes Required", "Canceled"]);

export class LinearCycleRootWorkflowPolicyImpl implements RootWorkflowPolicyInterface {
  assess(view: RootDagView): RootDispatchAssessment {
    const base = { rootIssueId: view.root.issue.issue_id };
    const rootState = view.root.issue.status_name;
    if (terminalRootStates.has(rootState)) return { ...base, readiness: "terminal" };
    if (rootState === "Needs Approval" || rootState === "Needs Info") return { ...base, readiness: "waiting_human" };
    const activeCycles = view.cycles.filter(({ issue }) => !terminalCycleStates.has(issue.status_name));
    if (activeCycles.length === 0) return rootState === "In Review" ? { ...base, readiness: "terminal" } : { ...base, readiness: "runnable" };
    const cycle = activeCycles[0]!;
    const plan = cycle.nodes.find((node) => node.issue.issue_kind === "plan");
    if (!plan) return attention(base, "plan_node_missing");
    if (["Draft", "Planning"].includes(cycle.issue.status_name)) {
      if (["Todo", "In Progress"].includes(plan.issue.status_name)) return runnable(base);
      if (plan.issue.status_name === "In Review") return rootState === "In Progress" ? runnable(base) : { ...base, readiness: "waiting_human" };
      return attention(base, "plan_state_not_dispatchable");
    }
    if (!["Sealed", "Executing", "Verifying", "Inconclusive", "Escalated"].includes(cycle.issue.status_name)) {
      return attention(base, "cycle_state_not_dispatchable");
    }
    if (plan.issue.status_name !== "Done") return attention(base, "plan_not_complete");
    const workNodes = cycle.nodes.filter((node) => node.issue.issue_kind === "work");
    const activeWork = workNodes.filter((node) => node.issue.status_name === "In Progress");
    if (activeWork.length > 1) return attention(base, "multiple_active_work_nodes");
    const readyWork = workNodes.filter((node) => ["Todo", "In Progress"].includes(node.issue.status_name)
      && node.blockedByIssueIds.every((dependencyId) => doneNode(cycle, dependencyId)));
    if (activeWork.length === 1) return runnable(base);
    if (readyWork.length > 0) return runnable(base);
    const verify = cycle.nodes.find((node) => node.issue.issue_kind === "verify");
    if (verify && workNodes.every((node) => node.issue.status_name === "Done" && hasCompletedStageRecord(node))
      && ["Todo", "In Progress"].includes(verify.issue.status_name)) return runnable(base);
    if (verify && verify.issue.status_name === "Done" && cycle.issue.status_name === "Inconclusive") return attention(base, "verify_retry_not_reopened");
    return attention(base, "no_ready_stage");
  }
}

function doneNode(cycle: RootCycleView, issueId: string): boolean {
  return cycle.nodes.some((node) => node.issue.issue_id === issueId
    && node.issue.status_name === "Done"
    && (node.issue.issue_kind === "plan" ? cycle.planContract !== undefined : hasCompletedStageRecord(node)));
}

function hasCompletedStageRecord(node: RootCycleView["nodes"][number]): boolean {
  return node.records.some((record) => record.kind === "work_completion"
    && record.nodeIssueId === node.issue.issue_id && record.workKey === node.marker.nodeKey);
}

function runnable(base: { rootIssueId: string }): RootDispatchAssessment {
  return { ...base, readiness: "runnable" };
}

function attention(base: { rootIssueId: string }, sanitizedReason: string): RootDispatchAssessment {
  return { ...base, readiness: "needs_attention", sanitizedReason };
}
