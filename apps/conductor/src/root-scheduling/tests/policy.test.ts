import assert from "node:assert/strict";
import test from "node:test";

import { LinearPriorityRootSchedulingPolicyImpl } from "../internal/LinearPriorityRootSchedulingPolicyImpl.js";

test("Root scheduling orders every Priority, Linear order, and identifier tie", () => {
  const policy = new LinearPriorityRootSchedulingPolicyImpl();
  const roots = [
    root("low", "low", 0),
    root("normal-z", "normal", 2, "SYM-20"),
    root("urgent", "urgent", 10),
    root("none", "no_priority", -10),
    root("high", "high", 5),
    root("normal-a", "normal", 2, "SYM-10"),
    root("normal-first", "normal", 1),
  ];

  assert.deepEqual(
    policy.evaluate(roots).orderedEligible.map(({ issueId }) => issueId),
    [
      "urgent",
      "high",
      "normal-first",
      "normal-a",
      "normal-z",
      "low",
      "none",
    ],
  );
  assert.deepEqual(roots.map(({ issueId }) => issueId), [
    "low",
    "normal-z",
    "urgent",
    "none",
    "high",
    "normal-a",
    "normal-first",
  ]);
});

test("Root scheduling excludes unresolved external and transitive blockers", () => {
  const policy = new LinearPriorityRootSchedulingPolicyImpl();
  const roots = [
    root("external-done", "normal", 1, "SYM-1", [
      blocker("external-done", "outside-done", "Done"),
    ]),
    root("external-active", "urgent", 1, "SYM-2", [
      blocker("external-active", "outside-active", "In Progress"),
    ]),
    root("chain-a", "urgent", 2, "SYM-3", [
      blocker("chain-a", "chain-b", "Todo"),
    ]),
    root("chain-b", "high", 1, "SYM-4", [
      blocker("chain-b", "chain-c", "In Review"),
    ]),
    root("chain-c", "low", 1, "SYM-5"),
  ];

  assert.deepEqual(
    policy.evaluate(roots).orderedEligible.map(({ issueId }) => issueId),
    ["external-done", "chain-c"],
  );
});

test("Root scheduling excludes self-cycles and every member of a multi-Root cycle", () => {
  const policy = new LinearPriorityRootSchedulingPolicyImpl();
  const roots = [
    root("self", "urgent", 1, "SYM-1", [
      blocker("self", "self", "Done"),
    ]),
    root("cycle-a", "urgent", 2, "SYM-2", [
      blocker("cycle-a", "cycle-b", "Done"),
    ]),
    root("cycle-b", "high", 1, "SYM-3", [
      blocker("cycle-b", "cycle-c", "Done"),
    ]),
    root("cycle-c", "normal", 1, "SYM-4", [
      blocker("cycle-c", "cycle-a", "Done"),
    ]),
    root("ready", "low", 1, "SYM-5"),
  ];

  assert.deepEqual(
    policy.evaluate(roots).orderedEligible.map(({ issueId }) => issueId),
    ["ready"],
  );
});

function root(
  issueId: string,
  priority: "urgent" | "high" | "normal" | "low" | "no_priority",
  order: number,
  identifier = issueId.toUpperCase(),
  blockers: Array<{
    sourceIssueId: string;
    targetIssueId: string;
    targetState: "Todo" | "In Progress" | "In Review" | "Done" | "Canceled";
  }> = [],
) {
  return {
    issueId,
    identifier,
    state: "Todo" as const,
    title: issueId,
    description: "",
    updatedAt: "2026-07-19T00:00:00Z",
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
    priority,
    order,
    blockers,
  };
}

function blocker(
  sourceIssueId: string,
  targetIssueId: string,
  targetState: "Todo" | "In Progress" | "In Review" | "Done" | "Canceled",
) {
  return { sourceIssueId, targetIssueId, targetState };
}
