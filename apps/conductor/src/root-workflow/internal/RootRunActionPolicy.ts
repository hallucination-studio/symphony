import { selectWorkflowLeaf } from "../../linear-tree/internal/LinearDepthFirstTreeTraversalPolicy.js";
import type { RootAction, RootRunView } from "../api/Models.js";
import { hashRootInput } from "./ManagedState.js";

export function computeRootAction(view: RootRunView): RootAction {
  if (view.root.state === "Done" || view.root.state === "Canceled") {
    return { kind: "idle_root" };
  }
  if (!view.managedComment) {
    return view.root.state === "Todo"
      ? { kind: "claim_root" }
      : { kind: "blocked_root", reason: "root_managed_comment_missing" };
  }
  if (view.phaseLabels.length === 0) {
    return {
      kind: "repair_root_phase",
      phase: deriveMissingPhase(view),
    };
  }
  if (view.phaseLabels.length > 1) {
    return { kind: "blocked_root", reason: "root_phase_ambiguous" };
  }
  if (view.managedComment.conductorId !== view.conductorId) {
    return { kind: "blocked_root", reason: "root_owned_by_other_conductor" };
  }
  if (
    !view.profile ||
    view.profile.profileId !== view.managedComment.performerProfileId ||
    view.profile.readiness !== "ready"
  ) {
    return { kind: "blocked_root", reason: "fixed_profile_not_ready" };
  }
  if (
    view.managedComment.plannedRootInputHash &&
    view.managedComment.plannedRootInputHash !== hashRootInput(view.root)
  ) {
    return { kind: "plan_root", reason: "root_input_changed" };
  }
  if (
    !view.managedComment.plannedRootInputHash &&
    view.phaseLabels[0] !== "planning"
  ) {
    return { kind: "plan_root" };
  }

  const phase = view.phaseLabels[0];
  if (phase === "planning") return { kind: "plan_root" };
  if (phase === "delivering") return { kind: "deliver_root" };
  if (phase === "in-review" || phase === "failed") return { kind: "idle_root" };

  const approval = view.workflowNodes.find(
    (node) => node.humanKind === "plan_approval",
  );
  if (approval?.state === "Canceled") {
    return { kind: "blocked_root", reason: "plan_approval_canceled" };
  }
  if (phase === "awaiting-human" && approval?.state !== "Done") {
    return approval
      ? { kind: "wait_human", nodeId: approval.issueId }
      : { kind: "blocked_root", reason: "plan_approval_missing" };
  }
  const treeAction = selectWorkflowLeaf(
    view.workflowNodes.filter((node) => node.humanKind !== "plan_approval"),
  );
  if (phase === "gating" && treeAction.kind !== "run_root_gate") {
    return treeAction;
  }
  return treeAction;
}

function deriveMissingPhase(view: RootRunView) {
  if (view.root.state === "In Review") return "in-review" as const;
  if (!view.managedComment?.plannedRootInputHash) return "planning" as const;
  const approval = view.workflowNodes.find(
    (node) => node.humanKind === "plan_approval",
  );
  if (approval?.state === "Canceled") return "blocked" as const;
  if (approval?.state !== "Done") return "awaiting-human" as const;
  const treeAction = selectWorkflowLeaf(
    view.workflowNodes.filter((node) => node.humanKind !== "plan_approval"),
  );
  if (treeAction.kind === "wait_human") return "awaiting-human" as const;
  if (treeAction.kind === "run_root_gate") return "gating" as const;
  if (treeAction.kind === "blocked_root") return "blocked" as const;
  return "working" as const;
}
