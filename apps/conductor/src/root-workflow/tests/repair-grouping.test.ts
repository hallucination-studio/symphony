import assert from "node:assert/strict";
import test from "node:test";

import { groupRepairFindings } from "../internal/RepairGroupingPolicy.js";

test("groups findings by shared scope, shared acceptance criteria, and dependency", () => {
  const groups = groupRepairFindings([
    finding("finding-3", "apps/conductor", ["criterion-a"]),
    finding("finding-1", "apps/conductor", ["criterion-a"]),
    finding("finding-2", "apps/podium", ["criterion-b"], ["finding-1"]),
    finding("finding-4", "apps/performer", ["criterion-c"]),
  ]);

  assert.deepEqual(groups.map((group) => group.findingIds), [["finding-1", "finding-2", "finding-3"], ["finding-4"]]);
  assert.match(groups[0]?.repairGroupId ?? "", /^repair-group:/u);
  assert.deepEqual(groups[0]?.acceptanceCriterionKeys, ["criterion-a", "criterion-b"]);
});

test("orders independent groups deterministically and rejects invalid dependencies", () => {
  const input = [finding("finding-z", "z", ["z"]), finding("finding-a", "a", ["a"])] as const;
  const first = groupRepairFindings(input);
  const second = groupRepairFindings([...input].reverse());

  assert.deepEqual(first, second);
  assert.throws(() => groupRepairFindings([finding("finding-1", "a", ["a"], ["missing"])]), /repair_dependency_unknown/u);
});

function finding(findingId: string, scope: string, criteria: string[], dependencyFindingIds: string[] = []) {
  return {
    findingId,
    affectedScope: [{ scopeKind: "repository_path" as const, identity: scope }],
    acceptanceCriteria: criteria.map((criterionKey) => ({ criterionKey, statement: criterionKey, verificationMethod: "test" })),
    dependencyFindingIds,
  };
}
