import assert from "node:assert/strict";
import test from "node:test";

import { parseRepositoryId, parseRootIssueId } from "../contracts/identity.js";
import type { LinearObservation } from "../contracts/observation.js";
import type { RootCandidate } from "../linear/api/LinearGatewayInterface.js";
import type { RuntimeEvent } from "../runtime-logs/StructuredLogger.js";
import { SerialConductor } from "./SerialConductor.js";

function candidate(root: string, status: RootCandidate["status"], priority: number): RootCandidate {
  return {
    root_id: parseRootIssueId(root),
    status,
    priority,
    created_at: `2026-07-${String(priority).padStart(2, "0")}T00:00:00.000Z`,
    repository_id: parseRepositoryId(`repo:${root}`),
    base_branch: "main",
  };
}

function fixture() {
  const firstId = parseRootIssueId("LIN-1");
  const secondId = parseRootIssueId("LIN-2");
  const statuses = new Map<RootCandidate["root_id"], RootCandidate["status"]>([
    [firstId, "In Progress"],
    [secondId, "Todo"],
  ]);
  const advances: string[] = [];
  const runtimeTokens = new Map<string, object>();
  const events: RuntimeEvent[] = [];
  let active = 0;
  let maximumActive = 0;
  let releaseFirst: (() => void) | null = null;
  let holdFirst = false;

  const linear = {
    discoverRoots: () => Promise.resolve([
      candidate(firstId, statuses.get(firstId) ?? "Done", 1),
      candidate(secondId, statuses.get(secondId) ?? "Done", 2),
    ]),
    readRoot: (rootId: RootCandidate["root_id"]): Promise<LinearObservation> => Promise.resolve({
      root_id: rootId,
      root_status: statuses.get(rootId) ?? "Done",
      active_cycle: null,
    }),
    mutate: () => Promise.reject(new Error("unexpected_scheduler_mutation")),
  };
  const advancer = {
    advance: async ({ candidate: root }: { candidate: RootCandidate }): Promise<LinearObservation> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      advances.push(root.root_id);
      runtimeTokens.set(root.root_id, runtimeTokens.get(root.root_id) ?? {});
      if (root.root_id === firstId && holdFirst) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      const nextStatus = root.root_id === firstId ? "In Review" : "In Progress";
      statuses.set(root.root_id, nextStatus);
      active -= 1;
      return { root_id: root.root_id, root_status: nextStatus, active_cycle: null };
    },
  };
  return {
    conductor: new SerialConductor(linear, advancer, { publish: (event) => events.push(event) }),
    firstId,
    secondId,
    advances,
    runtimeTokens,
    events,
    maximumActive: () => maximumActive,
    holdFirst: () => { holdFirst = true; },
    releaseFirst: () => { releaseFirst?.(); },
  };
}

test("SerialConductor suspends In Review without releasing its runtime and selects the next Root later", async () => {
  const f = fixture();

  const first = await f.conductor.tick();
  assert.equal(first.kind, "suspended_in_review");
  assert.equal(first.root_id, f.firstId);
  assert.deepEqual(f.advances, [f.firstId]);
  const retainedRuntime = f.runtimeTokens.get(f.firstId);
  assert.ok(retainedRuntime);

  const second = await f.conductor.tick();
  assert.equal(second.kind, "advanced");
  assert.equal(second.root_id, f.secondId);
  assert.deepEqual(f.advances, [f.firstId, f.secondId]);
  assert.equal(f.runtimeTokens.get(f.firstId), retainedRuntime);
  assert.equal(f.maximumActive(), 1);
  assert.deepEqual(f.events.map(({ event }) => event), [
    "discovery_started", "discovery_completed", "root_advance_started", "root_advance_completed",
    "discovery_started", "discovery_completed", "root_advance_started", "root_advance_completed",
  ]);
  assert.deepEqual(new Set(f.events.map(({ correlation_id }) => correlation_id)), new Set(["serial:1", "serial:2"]));
});

test("SerialConductor rejects a concurrent tick and never starts a second Root action", async () => {
  const f = fixture();
  f.holdFirst();

  const first = f.conductor.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.conductor.active_root_id, f.firstId);
  await assert.rejects(f.conductor.tick(), /serial_conductor_busy/u);
  assert.deepEqual(f.advances, [f.firstId]);
  assert.equal(f.maximumActive(), 1);

  f.releaseFirst();
  await first;
  assert.equal(f.conductor.active_root_id, null);
});

test("SerialConductor stops when an advance returns facts for another Root", async () => {
  const f = fixture();
  const events: RuntimeEvent[] = [];
  const wrong = new SerialConductor(
    {
      discoverRoots: () => Promise.resolve([candidate(f.firstId, "In Progress", 1)]),
      readRoot: () => Promise.resolve({ root_id: f.firstId, root_status: "In Progress", active_cycle: null }),
      mutate: () => Promise.reject(new Error("unexpected_scheduler_mutation")),
    },
    {
      advance: () => Promise.resolve({ root_id: f.secondId, root_status: "In Progress", active_cycle: null }),
    },
    { publish: (event) => events.push(event) },
  );

  await assert.rejects(wrong.tick(), /serial_advance_identity_mismatch/u);
  assert.equal(wrong.state, "stopped");
  assert.deepEqual(events.at(-1), {
    event: "serial_tick_failed",
    correlation_id: "serial:1",
    root_id: f.firstId,
    reason_code: "tick_failed",
  });
  await assert.rejects(wrong.tick(), /serial_conductor_not_idle/u);
});
