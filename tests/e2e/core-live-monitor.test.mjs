import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoreLiveMonitor,
  CORE_LIVE_PHASES,
} from "../../tools/e2e/core-live-monitor.mjs";

function childEvent(rootIssueId, performerId, turnId, eventKind) {
  return {
    event: "e2e_child_log",
    component: "conductor",
    stream: "stdout",
    message: JSON.stringify({
      event: "performer_turn_event",
      root_issue_id: rootIssueId,
      performer_id: performerId,
      turn_id: turnId,
      event_kind: eventKind,
    }),
  };
}

function rootState(phase, performerId = "conversation-1") {
  return {
    rootState: phase === "in-review" ? "In Review" : "Todo",
    phase,
    performerId,
    approvalState: phase === "awaiting-human" ? "In Progress" : "Todo",
    planApprovalCount: phase === "planning" || phase === "awaiting-human" ? 1 : 0,
    gateCount: phase === "gating" || phase === "delivering" || phase === "in-review" ? 1 : 0,
    workStates: phase === "in-review" ? ["Done"] : [],
  };
}

test("monitor enforces monotonic phases, exact priority order, and one active Turn", () => {
  const monitor = createCoreLiveMonitor({
    roots: [
      { rootIssueId: "root-high", priority: 1 },
      { rootIssueId: "root-medium", priority: 2 },
      { rootIssueId: "root-low", priority: 3 },
    ],
    now: () => 100,
  });

  monitor.observeReadback("root-high", rootState("planning"));
  monitor.observeEvent(childEvent("root-high", "conversation-1", "turn-1", "turn_started"));
  assert.throws(
    () => monitor.observeEvent(childEvent("root-medium", "conversation-2", "turn-2", "turn_started")),
    /e2e_turn_overlap/u,
  );
  monitor.observeEvent(childEvent("root-high", "conversation-1", "turn-1", "turn_completed"));
  monitor.observeReadback("root-high", rootState("awaiting-human"));
  assert.throws(
    () => monitor.observeReadback("root-high", rootState("planning")),
    /e2e_root_phase_regression/u,
  );
  monitor.observeReadback("root-medium", rootState("planning", "conversation-2"));
  monitor.observeEvent(childEvent("root-medium", "conversation-2", "turn-3", "turn_started"));
  monitor.observeEvent(childEvent("root-medium", "conversation-2", "turn-3", "turn_completed"));
  monitor.observeReadback("root-low", rootState("planning", "conversation-3"));
  monitor.observeEvent(childEvent("root-low", "conversation-3", "turn-4", "turn_started"));
  monitor.observeEvent(childEvent("root-low", "conversation-3", "turn-4", "turn_completed"));

  assert.deepEqual(monitor.evidence().planningOrder, ["root-high", "root-medium", "root-low"]);
  assert.deepEqual(monitor.evidence().executionOrder, []);
  assert.deepEqual(CORE_LIVE_PHASES.slice(0, 3), ["input-created", "discovered", "workspace-ready"]);
});

test("monitor rejects wrong Root ownership and stale Turn completion", () => {
  const monitor = createCoreLiveMonitor({
    roots: [{ rootIssueId: "root-1", priority: 1 }],
    now: () => 100,
  });
  assert.throws(
    () => monitor.observeReadback("foreign-root", rootState("planning")),
    /e2e_root_ownership_mismatch/u,
  );
  monitor.observeReadback("root-1", rootState("planning"));
  assert.throws(
    () => monitor.observeEvent(childEvent("root-1", "conversation-1", "turn-old", "turn_completed")),
    /e2e_turn_correlation_invalid/u,
  );
});

test("monitor correlates workspace and delivery events without accepting another Root", () => {
  const monitor = createCoreLiveMonitor({
    roots: [{ rootIssueId: "root-1", priority: 1 }],
    now: () => 100,
  });
  monitor.observeEvent({
    event: "workspace_ready",
    root_issue_id: "root-1",
    root_identifier: "SYM-1",
    branch: "symphony/runs/sym-1",
    workspace_id: "root-1",
    baseline_head: "abc123",
  });
  assert.throws(
    () => monitor.observeEvent({
      event: "delivery_completed",
      root_issue_id: "foreign",
      turn_id: "turn-1",
      performer_id: "conversation-1",
      delivery_kind: "local_branch",
      delivery_branch: "symphony/runs/sym-1",
      delivery_head: "def456",
    }),
    /e2e_root_ownership_mismatch/u,
  );
  monitor.observeEvent({
    event: "delivery_completed",
    root_issue_id: "root-1",
    turn_id: "turn-1",
    performer_id: "conversation-1",
    delivery_kind: "local_branch",
    delivery_branch: "symphony/runs/sym-1",
    delivery_head: "def456",
  });
  assert.equal(monitor.evidence().roots[0].deliveryHead, "def456");
  assert.equal("worktreePath" in monitor.evidence().roots[0], false);
});

test("monitor starts workspace deadline only after a Root is selected", () => {
  let now = 0;
  const monitor = createCoreLiveMonitor({
    roots: [
      { rootIssueId: "root-high", priority: 1 },
      { rootIssueId: "root-medium", priority: 2 },
    ],
    now: () => now,
    deadlines: { run: 1_000, workspaceReady: 10 },
  });

  now = 100;
  assert.doesNotThrow(() => monitor.checkDeadlines());
  monitor.observeEvent({ event: "root_selected", root_issue_id: "root-high" });
  now = 109;
  assert.doesNotThrow(() => monitor.checkDeadlines());
  monitor.observeEvent({
    event: "workspace_ready",
    root_issue_id: "root-high",
    root_identifier: "SYM-1",
    branch: "symphony/runs/sym-1",
    workspace_id: "root-high",
    baseline_head: "abc123",
  });

  now = 200;
  assert.doesNotThrow(() => monitor.checkDeadlines());
  monitor.observeEvent({ event: "root_selected", root_issue_id: "root-medium" });
  now = 210;
  assert.throws(() => monitor.checkDeadlines(), /e2e_workspace_ready_timeout/u);
});

test("monitor watchdog fails after two no-effect Turns and recovers on progress", () => {
  let now = 100;
  const monitor = createCoreLiveMonitor({
    roots: [{ rootIssueId: "root-1", priority: 1 }],
    now: () => now,
  });
  monitor.observeReadback("root-1", rootState("working"), { fingerprint: "same" });
  for (const turnId of ["turn-1", "turn-2"]) {
    monitor.observeEvent(childEvent("root-1", "conversation-1", turnId, "turn_started"));
    monitor.observeEvent(childEvent("root-1", "conversation-1", turnId, "turn_completed"));
    const readback = () => monitor.observeReadback("root-1", rootState("working"), {
      fingerprint: "same", brokerEffectCount: 0,
    });
    if (turnId === "turn-2") {
      assert.throws(readback, /e2e_root_progress_stalled/u);
    } else {
      assert.doesNotThrow(readback);
    }
  }

  now += 1;
  const recovery = createCoreLiveMonitor({
    roots: [{ rootIssueId: "root-1", priority: 1 }],
    now: () => now,
  });
  recovery.observeReadback("root-1", rootState("working"), { fingerprint: "a" });
  recovery.observeEvent(childEvent("root-1", "conversation-1", "turn-1", "turn_started"));
  recovery.observeEvent(childEvent("root-1", "conversation-1", "turn-1", "turn_completed"));
  recovery.observeReadback("root-1", rootState("working"), { fingerprint: "b", brokerEffectCount: 1 });
  recovery.observeEvent(childEvent("root-1", "conversation-1", "turn-2", "turn_started"));
  recovery.observeEvent(childEvent("root-1", "conversation-1", "turn-2", "turn_completed"));
  assert.doesNotThrow(() => recovery.observeReadback("root-1", rootState("working"), {
    fingerprint: "c", brokerEffectCount: 0,
  }));
});

test("monitor uses injected clock for named boundary deadlines and heartbeat", () => {
  let now = 0;
  const events = [];
  const monitor = createCoreLiveMonitor({
    roots: [{ rootIssueId: "root-1", priority: 1 }],
    now: () => now,
    deadlines: { run: 10, rootCompletion: 5 },
    heartbeatIntervalMs: 10,
    log: (event) => events.push(event),
  });
  monitor.startBoundary("rootCompletion", "root-1");
  now = 4;
  assert.doesNotThrow(() => monitor.checkDeadlines());
  monitor.heartbeat();
  assert.equal(events.length, 0);
  now = 10;
  monitor.heartbeat();
  assert.equal(events[0].event, "e2e_monitor_heartbeat");
  assert.throws(() => monitor.checkDeadlines(), /e2e_root_completion_timeout/u);
  let runNow = 0;
  const runMonitor = createCoreLiveMonitor({ roots: [], now: () => runNow, deadlines: { run: 10 } });
  runNow = 11;
  assert.throws(() => runMonitor.checkDeadlines(), /e2e_run_timeout/u);
});

test("monitor exposes every named boundary timeout as a stable code", () => {
  const cases = [
    ["runtimeReady", "e2e_runtime_ready_timeout"],
    ["rootDiscovery", "e2e_root_discovery_timeout"],
    ["workspaceReady", "e2e_workspace_ready_timeout"],
    ["allRoots", "e2e_all_roots_timeout"],
    ["cleanup", "e2e_cleanup_timeout"],
  ];
  for (const [name, code] of cases) {
    let now = 0;
    const monitor = createCoreLiveMonitor({
      roots: [{ rootIssueId: "root-1", priority: 1 }],
      now: () => now,
      deadlines: { [name]: 1 },
    });
    monitor.startBoundary(name, name === "runtimeReady" || name === "rootDiscovery"
      || name === "allRoots" || name === "cleanup" ? undefined : "root-1");
    now = 1;
    assert.throws(() => monitor.checkDeadlines(), new RegExp(code, "u"));
  }
});
