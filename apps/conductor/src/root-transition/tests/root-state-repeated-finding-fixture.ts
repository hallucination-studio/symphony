import type { CanonicalFact, CanonicalFactValue } from "../../linear-runtime/api/CanonicalFact.js";
import type { RecoveredRootState } from "../../linear-runtime/api/RootStateRecoveryInterface.js";

const observedAt = "2026-07-29T02:00:00.000Z";

function fact(value: CanonicalFactValue): CanonicalFact {
  const sourceId = value.kind === "linear_status" ? value.statusId
    : value.kind === "git_worktree" ? value.rootIssueId
      : value.kind === "linear_issue" ? value.issueId
        : value.kind === "linear_relation" ? value.relationId
          : "unused";
  return { identity: { sourceKind: value.kind, sourceId }, value, provenance: { actorKind: "unknown", observedAt } };
}

export function repeatedFindingState(): RecoveredRootState {
  const issue = (
    issueId: string, issueKind: "root" | "cycle" | "finding", parentIssueId: string | undefined,
    statusName: string, statusCategory: "unstarted" | "started" | "completed", isArchived: boolean, createdAt: string,
  ): CanonicalFact => fact({
    kind: "linear_issue", issueId, identifier: issueId, projectId: "project-1",
    ...(parentIssueId === undefined ? {} : { parentIssueId }),
    statusId: `status-${statusName.toLowerCase().replaceAll(" ", "-")}`, statusName, statusCategory,
    statusPosition: 1, order: 0, depth: parentIssueId ? (issueKind === "cycle" ? 1 : 2) : 0,
    title: issueId, description: `${issueId} evidence`, labels: [`symphony:kind/${issueKind}`],
    isArchived, issueKind, createdAt, updatedAt: observedAt,
  });
  return {
    rootIssueId: "root-1", contentDigest: "sha256:repeated-finding",
    observation: { facts: [
      fact({ kind: "linear_status", statusId: "status-canceled", name: "Canceled", category: "canceled", position: 4 }),
      issue("root-1", "root", undefined, "In Progress", "started", false, "2026-07-27T00:00:00.000Z"),
      issue("cycle-1", "cycle", "root-1", "Changes Required", "completed", true, "2026-07-28T00:00:00.000Z"),
      issue("finding-1", "finding", "cycle-1", "Todo", "unstarted", true, "2026-07-28T01:00:00.000Z"),
      issue("cycle-2", "cycle", "root-1", "Verifying", "started", false, "2026-07-29T00:00:00.000Z"),
      issue("finding-2", "finding", "cycle-2", "Todo", "unstarted", false, "2026-07-29T01:00:00.000Z"),
      fact({ kind: "linear_relation", relationId: "lineage-1", relationKind: "triggered_by", sourceIssueId: "finding-2", targetIssueId: "finding-1" }),
      fact({ kind: "git_worktree", rootIssueId: "root-1", repositoryId: "repo-1", branch: "root-1", headRevision: "abc", baseRevision: "base", isClean: true, changedPaths: [] }),
    ] },
  };
}
