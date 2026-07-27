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
      updatedAt: "2026-07-26T00:00:00.000Z",
      projectId: "project-1",
      priority: "high",
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123def456" }],
      isDelegatedToSymphony: false, isArchived: false,
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
      updatedAt: "2026-07-26T00:00:00.000Z",
      projectId: "project-1",
      priority: "high",
      blockers: [],
      rootConductorLabels: [{ conductorShortHash: "abc123def456" }],
      isDelegatedToSymphony: true, isArchived: false,
    }],
  });

  assert.deepEqual(roots.map(({ issueId }) => issueId), ["root-1"]);
});
