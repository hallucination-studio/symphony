import assert from "node:assert/strict";
import test from "node:test";

import { discoverCurrentRoots } from "../MultiRootDiscoveryPolicy.js";

test("does not discover a routed Root before the user delegates it to Symphony", () => {
  const roots = discoverCurrentRoots({
    projectId: "project-1",
    conductorId: "conductor-1",
    conductorShortHash: "abc123def456",
    conductorPool: [{ conductorShortHash: "abc123def456" }],
    roots: [{
      issueId: "root-1",
      identifier: "SYM-1",
      state: "Todo",
      title: "External Root",
      description: "Implement the requested behavior.",
      updatedAt: "2026-07-26T00:00:00.000Z",
      projectId: "project-1",
      parentIssueId: null,
      priority: "high",
      order: 0,
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123def456" }],
      isDelegatedToSymphony: false,
    }],
  });

  assert.deepEqual(roots, []);
});

test("discovers a routed Root only after the user delegates it to Symphony", () => {
  const roots = discoverCurrentRoots({
    projectId: "project-1",
    conductorId: "conductor-1",
    conductorShortHash: "abc123def456",
    conductorPool: [{ conductorShortHash: "abc123def456" }],
    roots: [{
      issueId: "root-1",
      identifier: "SYM-1",
      state: "Todo",
      title: "External Root",
      description: "Implement the requested behavior.",
      updatedAt: "2026-07-26T00:00:00.000Z",
      projectId: "project-1",
      parentIssueId: null,
      priority: "high",
      order: 0,
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123def456" }],
      isDelegatedToSymphony: true,
    }],
  });

  assert.deepEqual(roots.map(({ issueId }) => issueId), ["root-1"]);
});
