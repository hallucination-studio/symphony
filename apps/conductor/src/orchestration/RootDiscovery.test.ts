import assert from "node:assert/strict";
import test from "node:test";

import { parseRepositoryId, parseRootIssueId } from "../contracts/identity.js";
import type { LinearObservation } from "../contracts/observation.js";
import type { LinearGatewayInterface, RootCandidate } from "../linear/api/LinearGatewayInterface.js";
import { RootDiscovery } from "./RootDiscovery.js";

function candidate(rootId: string, status: RootCandidate["status"], priority: number): RootCandidate {
  return {
    root_id: parseRootIssueId(rootId),
    status,
    priority,
    created_at: `2026-07-${String(priority).padStart(2, "0")}T00:00:00.000Z`,
    repository_id: parseRepositoryId(`repo:${rootId}`),
    base_branch: "main",
  };
}

function observation(root: RootCandidate): LinearObservation {
  return { root_id: root.root_id, root_status: root.status, active_cycle: null };
}

function gateway(roots: readonly RootCandidate[], reads: ReadonlyMap<string, LinearObservation>) {
  const readIds: string[] = [];
  const linear: LinearGatewayInterface = {
    discoverRoots: () => Promise.resolve(roots),
    readRoot: (rootId) => {
      readIds.push(rootId);
      const value = reads.get(rootId);
      return value ? Promise.resolve(value) : Promise.reject(new Error("missing_read"));
    },
    mutate: () => Promise.reject(new Error("unexpected_mutation")),
  };
  return { discovery: new RootDiscovery(linear), readIds };
}

test("serial discovery skips non-executable Roots and admits only the first fresh executable candidate", async () => {
  const inReview = candidate("LIN-1", "In Review", 1);
  const todo = candidate("LIN-2", "Todo", 2);
  const later = candidate("LIN-3", "In Progress", 3);
  const fixture = gateway([inReview, todo, later], new Map([
    [todo.root_id, observation(todo)],
    [later.root_id, observation(later)],
  ]));

  const admitted = await fixture.discovery.nextExecutable();

  assert.deepEqual(admitted, { candidate: todo, observation: observation(todo) });
  assert.deepEqual(fixture.readIds, ["LIN-2"]);
});

test("discovery returns null when only In Review or Done Roots exist", async () => {
  const fixture = gateway([
    candidate("LIN-1", "In Review", 1),
    candidate("LIN-2", "Done", 2),
  ], new Map());

  assert.equal(await fixture.discovery.nextExecutable(), null);
  assert.deepEqual(fixture.readIds, []);
});

test("admission fails closed when fresh Root identity or status differs from discovery", async () => {
  const todo = candidate("LIN-1", "Todo", 1);
  const staleStatus = gateway([todo], new Map([
    [todo.root_id, { ...observation(todo), root_status: "In Progress" }],
  ]));
  await assert.rejects(staleStatus.discovery.nextExecutable(), /root_admission_facts_changed/u);

  const wrongIdentity = gateway([todo], new Map([
    [todo.root_id, { ...observation(todo), root_id: parseRootIssueId("LIN-9") }],
  ]));
  await assert.rejects(wrongIdentity.discovery.nextExecutable(), /root_admission_identity_mismatch/u);
});
