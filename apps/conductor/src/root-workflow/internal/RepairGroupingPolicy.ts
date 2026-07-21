import { createHash } from "node:crypto";

import type { AcceptanceCriterion, AffectedScope } from "../api/ManagedRecords.js";

export interface RepairFindingInput {
  findingId: string;
  affectedScope: ReadonlyArray<AffectedScope>;
  acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
  dependencyFindingIds?: ReadonlyArray<string>;
}

export interface RepairGroup {
  repairGroupId: string;
  findingIds: string[];
  affectedScope: AffectedScope[];
  acceptanceCriterionKeys: string[];
}

export function groupRepairFindings(findings: readonly RepairFindingInput[]): RepairGroup[] {
  const byId = new Map<string, RepairFindingInput>();
  for (const finding of findings) {
    if (!finding.findingId || byId.has(finding.findingId)) throw new Error("repair_finding_duplicate");
    byId.set(finding.findingId, finding);
  }
  for (const finding of findings) {
    for (const dependencyId of finding.dependencyFindingIds ?? []) {
      if (!byId.has(dependencyId)) throw new Error("repair_dependency_unknown");
      if (dependencyId === finding.findingId) throw new Error("repair_dependency_self");
    }
  }

  const parent = new Map(findings.map((finding) => [finding.findingId, finding.findingId]));
  const find = (findingId: string): string => {
    const current = parent.get(findingId);
    if (!current) throw new Error("repair_finding_unknown");
    if (current === findingId) return current;
    const root = find(current);
    parent.set(findingId, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent.set(leftRoot, rightRoot);
  };

  for (let leftIndex = 0; leftIndex < findings.length; leftIndex += 1) {
    const left = findings[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < findings.length; rightIndex += 1) {
      const right = findings[rightIndex]!;
      if (coupled(left, right)) union(left.findingId, right.findingId);
    }
    for (const dependencyId of left.dependencyFindingIds ?? []) union(left.findingId, dependencyId);
  }

  const members = new Map<string, RepairFindingInput[]>();
  for (const finding of findings) {
    const group = members.get(find(finding.findingId)) ?? [];
    group.push(finding);
    members.set(find(finding.findingId), group);
  }

  return [...members.values()]
    .map((group) => {
      const findingIds = group.map((finding) => finding.findingId).sort((left, right) => left.localeCompare(right));
      const scopes = new Map<string, AffectedScope>();
      const criteria = new Set<string>();
      for (const finding of group) {
        for (const scope of finding.affectedScope) scopes.set(`${scope.scopeKind}:${scope.identity}`, scope);
        for (const criterion of finding.acceptanceCriteria) criteria.add(criterion.criterionKey);
      }
      return {
        repairGroupId: `repair-group:${createHash("sha256").update(findingIds.join("\n")).digest("hex").slice(0, 32)}`,
        findingIds,
        affectedScope: [...scopes.values()].sort(scopeOrder),
        acceptanceCriterionKeys: [...criteria].sort((left, right) => left.localeCompare(right)),
      };
    })
    .sort((left, right) => left.findingIds[0]!.localeCompare(right.findingIds[0]!));
}

function coupled(left: RepairFindingInput, right: RepairFindingInput): boolean {
  const rightScopes = new Set(right.affectedScope.map((scope) => `${scope.scopeKind}:${scope.identity}`));
  if (left.affectedScope.some((scope) => rightScopes.has(`${scope.scopeKind}:${scope.identity}`))) return true;
  const rightCriteria = new Set(right.acceptanceCriteria.map((criterion) => criterion.criterionKey));
  return left.acceptanceCriteria.some((criterion) => rightCriteria.has(criterion.criterionKey));
}

function scopeOrder(left: AffectedScope, right: AffectedScope): number {
  return `${left.scopeKind}:${left.identity}`.localeCompare(`${right.scopeKind}:${right.identity}`);
}
