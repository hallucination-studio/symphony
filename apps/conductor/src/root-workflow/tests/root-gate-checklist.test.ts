import assert from "node:assert/strict";
import test from "node:test";

import {
  ROOT_GATE_TITLE,
  createRootGateDescription,
  validateRootGateNode,
} from "../internal/RootGateChecklist.js";

const rootIssueId = "root-1";

test("Root Gate description has the exact typed unchecked checklist", () => {
  assert.equal(ROOT_GATE_TITLE, "[Root Gate] Acceptance Checklist");
  assert.equal(createRootGateDescription(false), [
    "## Root Gate Checklist",
    "- [ ] `root-facts`: Root目标和最新Root facts仍然一致",
    "- [ ] `work-evidence`: 每个有效Work child都有匹配的completion evidence",
    "- [ ] `git-checks`: 声明的Git checks通过，且worktree状态符合交付要求",
    "- [ ] `blockers`: 所有Root blocker都处于Done或Canceled",
    "- [ ] `delivery`: 当前commit和delivery branch满足Root delivery precondition",
  ].join("\n"));
});

test("Root Gate validator accepts only the exact checked node", () => {
  const node = {
    issueId: "gate-1",
    identifier: "SYM-2",
    parentIssueId: rootIssueId,
    siblingOrder: 2,
    kind: "work" as const,
    state: "Done" as const,
    title: ROOT_GATE_TITLE,
    description: createRootGateDescription(true),
    updatedAt: "2026-07-20T00:00:00Z",
    origin: "symphony" as const,
    managedMarker: `${rootIssueId}:root-gate`,
  };

  assert.equal(validateRootGateNode(rootIssueId, node, true), undefined);
  assert.equal(validateRootGateNode(rootIssueId, { ...node, description: createRootGateDescription(false) }, true),
    "root_gate_checklist_incomplete");
  assert.equal(validateRootGateNode(rootIssueId, { ...node, managedMarker: "root-2:root-gate" }, true),
    "root_gate_marker_invalid");
  assert.equal(validateRootGateNode(rootIssueId, {
    ...node,
    description: `${createRootGateDescription(true)}\n- [x] unknown: unexpected`,
  }, true), "root_gate_checklist_invalid");
});
