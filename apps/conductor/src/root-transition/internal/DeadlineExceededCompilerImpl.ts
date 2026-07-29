import { workflowKindLabel } from "../../linear-gateway/api/WorkflowKindLabels.js";
import type {
  RootMechanicalConvergenceCompilerInput,
  RootMechanicalConvergenceCompilerResult,
} from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, {
  kind: "conclude_deadline_exceeded_cycle" | "conclude_deadline_exceeded_root";
}>;

export class DeadlineExceededCompilerImpl {
  compile(input: { target: Target } & Pick<RootMechanicalConvergenceCompilerInput, "facts" | "view">): RootMechanicalConvergenceCompilerResult {
    const { target, facts, view } = input;
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        root.status_category === "completed" || root.status_category === "canceled") return invalid("topology_invalid");

    const convergence = facts.rootSnapshot.root.convergence;
    const nativeCycles = view.tree.issues.filter(({ issue_kind, parent_issue_id }) =>
      issue_kind === "cycle" && parent_issue_id === root.issue_id);
    if (facts.rootSnapshot.root.issue.remoteVersion !== root.remote_version ||
        facts.rootSnapshot.cycles.length !== nativeCycles.length ||
        convergence.view.cycleCount !== nativeCycles.length) return invalid("topology_invalid");
    const observedAt = Date.parse(view.tree.observed_at);
    const deadlineAt = Date.parse(convergence.policy.deadlineAt);
    if (!Number.isFinite(observedAt) || !Number.isFinite(deadlineAt) ||
        !convergence.view.isDeadlineExceeded || observedAt < deadlineAt) return invalid("target_stale");

    const canceled = view.tree.status_catalog.filter(({ name }) => name === "Canceled");
    if (canceled.length !== 1) return invalid("status_catalog_invalid");
    const activeCycles = view.tree.issues.filter(({ issue_kind, parent_issue_id, is_archived, status_category }) =>
      issue_kind === "cycle" && parent_issue_id === root.issue_id && !is_archived &&
      status_category !== "completed" && status_category !== "canceled");

    if (target.kind === "conclude_deadline_exceeded_cycle") {
      const cycle = activeCycles.length === 1 ? activeCycles[0] : undefined;
      if (!cycle || cycle.issue_id !== target.cycleIssueId || cycle.project_id !== root.project_id ||
          convergence.view.activeCycleIssueId !== cycle.issue_id ||
          !facts.rootSnapshot.cycles.some(({ cycleIssue, isArchived }) =>
            cycleIssue.issueId === cycle.issue_id && cycleIssue.remoteVersion === cycle.remote_version &&
            !cycleIssue.isArchived && !isArchived)) {
        return invalid("topology_invalid");
      }
      return {
        kind: "effect",
        command: {
          kind: "update_workflow_issue",
          writeId: mechanicalWriteId([root.issue_id, cycle.issue_id, cycle.remote_version, "root-deadline-cycle"]),
          expectedProjectId: root.project_id,
          rootIssueId: root.issue_id,
          expectedRootRemoteVersion: root.remote_version,
          target: {
            targetIssueId: cycle.issue_id,
            expectedRemoteVersion: cycle.remote_version,
            expectedStatusId: cycle.status_id,
            expectedParentIssueId: root.issue_id,
            expectedIsArchived: false,
          },
          statusId: canceled[0]!.status_id,
          title: cycle.title,
          description: [
            "# Recovery Conclusion", "", "The Root execution deadline was exceeded before this Cycle completed.", "",
            "## Outcome", "", "recovery_abandoned",
          ].join("\n"),
          labelNames: ["Recovery Abandoned", workflowKindLabel("cycle")],
          parentAssignment: { mode: "retain" },
          order: cycle.order,
        },
      };
    }

    if (activeCycles.length > 0 || convergence.view.activeCycleIssueId !== undefined) {
      return invalid("topology_invalid");
    }
    const labelNames = [...new Set([...root.labels, "Deadline Exceeded", workflowKindLabel("root")])];
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([root.issue_id, root.remote_version, "root-deadline-terminal"]),
        expectedProjectId: root.project_id,
        rootIssueId: root.issue_id,
        expectedRootRemoteVersion: root.remote_version,
        target: {
          targetIssueId: root.issue_id,
          expectedRemoteVersion: root.remote_version,
          expectedStatusId: root.status_id,
          expectedIsArchived: false,
        },
        statusId: canceled[0]!.status_id,
        title: root.title,
        description: root.description,
        labelNames,
        parentAssignment: { mode: "retain" },
        order: root.order,
      },
    };
  }
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
