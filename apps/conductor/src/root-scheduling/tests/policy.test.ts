import assert from "node:assert/strict";
import test from "node:test";

import { LinearPriorityRootSchedulingPolicyImpl } from "../internal/LinearPriorityRootSchedulingPolicyImpl.js";

test("Root scheduling preempts older Roots within each priority tier", () => {
  const policy = new LinearPriorityRootSchedulingPolicyImpl();
  const roots = [
    root("low", "low", 0, "SYM-60", [], "2026-07-22T00:00:00Z"),
    root("normal-old", "normal", 1, "SYM-10", [], "2026-07-19T00:00:00Z"),
    root("urgent-old", "urgent", 99, "SYM-20", [], "2026-07-19T00:00:00Z"),
    root("none", "no_priority", -10, "SYM-70", [], "2026-07-23T00:00:00Z"),
    root("high-new", "high", 1, "SYM-40", [], "2026-07-21T00:00:00Z"),
    root("urgent-new", "urgent", 1, "SYM-30", [], "2026-07-20T00:00:00Z"),
    root("normal-new-z", "normal", 99, "SYM-50", [], "2026-07-22T00:00:00Z"),
    root("normal-new-a", "normal", 2, "SYM-05", [], "2026-07-22T00:00:00Z"),
  ];

  assert.deepEqual(
    policy.evaluate(roots).orderedEligible.map(({ issueId }) => issueId),
    [
      "urgent-new",
      "urgent-old",
      "high-new",
      "normal-new-a",
      "normal-new-z",
      "normal-old",
      "low",
      "none",
    ],
  );
  assert.deepEqual(roots.map(({ issueId }) => issueId), [
    "low",
    "normal-old",
    "urgent-old",
    "none",
    "high-new",
    "urgent-new",
    "normal-new-z",
    "normal-new-a",
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

test("Root scheduling compares latest updates before the stable identifier tie-breaker", () => {
  const policy = new LinearPriorityRootSchedulingPolicyImpl();
  const ordered = policy.evaluate([
    root("old", "high", 1, "SYM-10", [], "2026-07-19T00:00:00Z"),
    root("new", "high", 99, "SYM-20", [], "2026-07-20T00:00:00Z"),
    root("lexical-second", "high", 99, "SYM-2", [], "2026-07-20T00:00:00Z"),
    root("lexical-first", "high", 1, "SYM-10", [], "2026-07-20T00:00:00Z"),
  ]).orderedEligible;

  assert.deepEqual(
    ordered.map(({ issueId }) => issueId),
    ["lexical-first", "lexical-second", "new", "old"],
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
  updatedAt = "2026-07-19T00:00:00Z",
) {
  return {
    issueId,
    identifier,
    state: "Todo" as const,
    title: issueId,
    description: "",
    updatedAt,
    projectId: "project-1",
    parentIssueId: null,
    isDelegatedToSymphony: true,
    priority,
    order,
    blockers,
    rootConductorLabels: [],
  };
}

function blocker(
  sourceIssueId: string,
  targetIssueId: string,
  targetState: "Todo" | "In Progress" | "In Review" | "Done" | "Canceled",
) {
  return { sourceIssueId, targetIssueId, targetState };
}
