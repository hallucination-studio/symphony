import { expect, test } from "vitest";

import type { AgentKind, RootAction, RootStatus, RootView } from "./types";

const rootStatuses: RootStatus[] = ["running", "waiting", "needs_attention", "completed"];
const rootActions: RootAction[] = [
  { kind: "open_linear", rootId: "root-1" },
  { kind: "open_workspace", rootId: "root-1" },
  { kind: "open_delivery", rootId: "root-1" },
  { kind: "open_diagnostics", rootId: "root-1" },
  { kind: "cleanup_workspace", rootId: "root-1" },
];
const codex: AgentKind = "codex";
const root: RootView = {
  rootId: "root-1",
  bindingId: "project-1",
  identifier: "ENG-1",
  title: "Improve routing",
  priority: 2,
  status: "waiting",
  latestEvent: "Waiting for capacity",
  queuePosition: 1,
  observedAt: "2026-08-06T00:00:00.000Z",
  actions: rootActions.map(({ kind }) => ({ kind, available: false, reason: "unavailable" })),
};

test("Root view and action contracts expose the bounded operator surface", () => {
  expect(rootStatuses).toEqual(["running", "waiting", "needs_attention", "completed"]);
  expect(rootActions.map(({ kind }) => kind)).toEqual([
    "open_linear",
    "open_workspace",
    "open_delivery",
    "open_diagnostics",
    "cleanup_workspace",
  ]);
  expect(root.status).toBe("waiting");
  expect(codex).toBe("codex");
});
