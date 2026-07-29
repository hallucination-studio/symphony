import { isDeepStrictEqual } from "node:util";

import { deriveOpenFindingPersistence } from "../../root-reconciliation/internal/OpenFindingPersistence.js";
import type { RootMechanicalConvergenceCompilerInput, RootMechanicalConvergenceCompilerResult } from "../api/RootMechanicalConvergenceCompilerInterface.js";
import type { RootMechanicalTarget } from "../api/RootTransitionPolicyInterface.js";
import { mechanicalWriteId } from "./MechanicalWriteId.js";

type Target = Extract<RootMechanicalTarget, { kind: "conclude_repeated_finding_exhausted_cycle" }>;

export class RepeatedFindingExhaustedCycleCompilerImpl {
  compile(input: {
    target: Target;
  } & Pick<RootMechanicalConvergenceCompilerInput, "facts" | "view">): RootMechanicalConvergenceCompilerResult {
    const { target, facts, view } = input;
    const root = view.tree.issues.find(({ issue_id }) => issue_id === view.root.issueId);
    const cycle = view.tree.issues.find(({ issue_id }) => issue_id === target.cycleIssueId);
    const convergence = facts.rootSnapshot.root.convergence;
    const activeCycles = view.tree.issues.filter(({ issue_kind, is_archived, status_category }) =>
      issue_kind === "cycle" && !is_archived && status_category !== "completed" && status_category !== "canceled");
    const nativeCycles = view.tree.issues.filter(({ issue_kind, parent_issue_id }) =>
      issue_kind === "cycle" && parent_issue_id === root?.issue_id);
    if (!root || root.issue_kind !== "root" || root.is_archived || root.parent_issue_id !== undefined ||
        root.project_id !== view.root.projectId || view.tree.root_issue_id !== root.issue_id ||
        !view.complete || !view.tree.coverage.is_complete || view.tree.coverage.omissions.length > 0 ||
        facts.rootSnapshot.root.issue.remoteVersion !== root.remote_version ||
        !cycle || cycle.issue_kind !== "cycle" || cycle.parent_issue_id !== root.issue_id || cycle.is_archived ||
        cycle.project_id !== root.project_id || convergence.view.activeCycleIssueId !== cycle.issue_id ||
        activeCycles.length !== 1 || activeCycles[0]?.issue_id !== cycle.issue_id ||
        convergence.view.cycleCount !== nativeCycles.length || facts.rootSnapshot.cycles.length !== nativeCycles.length ||
        !facts.rootSnapshot.cycles.some(({ cycleIssue, isArchived }) =>
          cycleIssue.issueId === cycle.issue_id && cycleIssue.remoteVersion === cycle.remote_version &&
          !cycleIssue.isArchived && !isArchived)) return invalid("topology_invalid");
    let lineages;
    try {
      lineages = deriveOpenFindingPersistence(view.tree, root.issue_id, cycle.issue_id);
    } catch {
      return invalid("topology_invalid");
    }
    const snapshot = [...convergence.view.openFindingPersistence]
      .sort((left, right) => compareCodePoints(left.findingId, right.findingId));
    const derivedSnapshot = lineages.map(({ findingId, openCycleCount }) => ({ findingId, openCycleCount }));
    const atLimit = lineages.filter(({ openCycleCount }) =>
      openCycleCount >= convergence.policy.maxSameOpenFindingCycles);
    const atLimitIds = atLimit.map(({ findingId }) => findingId).sort(compareCodePoints);
    if (!isDeepStrictEqual(snapshot, derivedSnapshot) || atLimitIds.length === 0 ||
        !sameIds(target.findingIssueIds, atLimitIds)) return invalid("topology_invalid");

    const lineageFindingIds = new Set(atLimit.flatMap(({ findingIds }) => findingIds));
    const lineageRelations = view.tree.relations.filter(({ relation_kind, source_issue_id, target_issue_id }) =>
      relation_kind === "triggered_by" && lineageFindingIds.has(source_issue_id) && lineageFindingIds.has(target_issue_id));
    if (lineageRelations.length !== atLimit.reduce((count, lineage) =>
      count + lineage.findingIds.length - 1, 0)) return invalid("topology_invalid");

    const canceled = view.tree.status_catalog.filter(({ name }) => name === "Canceled");
    if (canceled.length !== 1) return invalid("status_catalog_invalid");
    return {
      kind: "effect",
      command: {
        kind: "update_workflow_issue",
        writeId: mechanicalWriteId([
          root.issue_id, cycle.issue_id, cycle.remote_version, ...atLimitIds, "repeated-finding-limit-exhausted",
        ]),
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
          "# Recovery Conclusion", "",
          "The same open Finding persisted through the configured Cycle limit.", "",
          "## Outcome", "", "recovery_exhausted",
        ].join("\n"),
        labelNames: ["Recovery Exhausted", "symphony:kind/cycle"],
        parentAssignment: { mode: "retain" },
        order: cycle.order,
      },
    };
  }
}

function sameIds(left: string[], right: string[]): boolean {
  return new Set(left).size === left.length && left.length === right.length &&
    [...left].sort(compareCodePoints).every((value, index) => value === right[index]);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(
  reason: Extract<RootMechanicalConvergenceCompilerResult, { kind: "invalid_facts" }>["reason"],
): RootMechanicalConvergenceCompilerResult {
  return { kind: "invalid_facts", reason };
}
