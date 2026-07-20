export const CORE_LIVE_PHASES = Object.freeze([
  "input-created",
  "discovered",
  "workspace-ready",
  "conversation-opened",
  "planning-turn-started",
  "plan-published",
  "waiting-human",
  "human-response-applied",
  "execution-turn-started",
  "work-evidence-confirmed",
  "gate-checked",
  "delivery-confirmed",
  "root-in-review",
]);

const PHASE_INDEX = new Map(CORE_LIVE_PHASES.map((phase, index) => [phase, index]));
const DEFAULT_DEADLINES = Object.freeze({
  run: 25 * 60_000,
  runtimeReady: 60_000,
  rootDiscovery: 30_000,
  workspaceReady: 30_000,
  turn: 120_000,
  planning: 420_000,
  humanInput: 30_000,
  rootCompletion: 240_000,
  allRoots: 780_000,
  cleanup: 30_000,
});

export function createCoreLiveMonitor({
  roots = [],
  now = Date.now,
  log = () => undefined,
  deadlines = {},
  heartbeatIntervalMs = 10_000,
  maxStalledTurns = 2,
} = {}) {
  const configuredDeadlines = { ...DEFAULT_DEADLINES, ...deadlines };
  const records = new Map();
  const priorities = [];
  const boundaries = new Map();
  const pendingEvents = new Map();
  const planningSequence = [];
  const executionSequence = [];
  const startedAt = now();
  let activeTurn;
  let lastHeartbeatAt = startedAt;
  let registrationClosed = roots.length > 0;

  for (const root of roots) registerRoot(root);

  return Object.freeze({
    registerRoot,
    registerRoots(values) {
      if (!Array.isArray(values)) throw monitorError("e2e_root_ownership_mismatch");
      for (const value of values) registerRoot(value);
      registrationClosed = true;
      for (const [rootIssueId, events] of pendingEvents) {
        if (!records.has(rootIssueId)) continue;
        pendingEvents.delete(rootIssueId);
        for (const event of events) observeEvent(event);
      }
    },
    observeEvent,
    observeReadback,
    startBoundary,
    completeBoundary,
    checkDeadlines,
    heartbeat,
    pendingTurnId(rootIssueId) {
      const record = recordFor(rootIssueId);
      return record.lastTurnCompletedAt === undefined ? undefined : record.lastTurnId;
    },
    evidence,
  });

  function registerRoot({ rootIssueId, priority } = {}) {
    if (!safeId(rootIssueId) || !Number.isSafeInteger(priority)
      || records.has(rootIssueId)) {
      throw monitorError("e2e_root_ownership_mismatch");
    }
    const timestamp = now();
    records.set(rootIssueId, {
      rootIssueId,
      priority,
      phase: "input-created",
      phaseStartedAt: timestamp,
      lastProgressAt: timestamp,
      fingerprint: undefined,
      performerId: undefined,
      workspace: undefined,
      delivery: undefined,
      planningTurns: [],
      executionTurns: [],
      noEffectTurns: 0,
      pendingTurn: undefined,
      lastCompletedTurn: undefined,
      lastCompletedFingerprint: undefined,
      lastTurnId: undefined,
      lastTurnCompletedAt: undefined,
    });
    priorities.push({ rootIssueId, priority });
  }

  function observeEvent(event) {
    if (!event || typeof event !== "object") return;
    if (typeof event.root_issue_id === "string" && !records.has(event.root_issue_id)) {
      if (!registrationClosed) {
        const queued = pendingEvents.get(event.root_issue_id) ?? [];
        queued.push(event);
        pendingEvents.set(event.root_issue_id, queued);
        return;
      }
      throw monitorError("e2e_root_ownership_mismatch");
    }
    if (event.event === "workspace_ready" || event.event === "delivery_completed") {
      const record = recordFor(event.root_issue_id);
      if (event.event === "workspace_ready") {
        if (!safeId(event.workspace_id) || !safeBranch(event.branch)
          || !safeValue(event.baseline_head) || !safeId(event.root_identifier)) {
          throw monitorError("e2e_workspace_evidence_invalid");
        }
        record.workspace = {
          workspaceId: event.workspace_id,
          branch: event.branch,
          baselineHead: event.baseline_head,
        };
        boundaries.delete(boundaryKey("workspaceReady", record.rootIssueId));
        advance(record, "workspace-ready");
        progress(record);
        return;
      }
      if (!safeId(event.turn_id) || !safeId(event.performer_id)
        || !["pull_request", "remote_branch", "local_branch"].includes(event.delivery_kind)
        || !safeBranch(event.delivery_branch) || !safeValue(event.delivery_head)) {
        throw monitorError("e2e_delivery_evidence_invalid");
      }
      if (record.performerId && record.performerId !== event.performer_id) {
        throw monitorError("e2e_root_readback_mismatch");
      }
      record.performerId = event.performer_id;
      record.delivery = {
        kind: event.delivery_kind,
        branch: event.delivery_branch,
        head: event.delivery_head,
        ...(event.pull_request_url ? { pullRequestUrl: event.pull_request_url } : {}),
      };
      advance(record, "delivery-confirmed");
      progress(record);
      return;
    }
    if (event.event !== "e2e_child_log" || event.component !== "conductor"
      || typeof event.message !== "string") return;
    let value;
    try { value = JSON.parse(event.message); } catch { return; }
    if (value?.event === "workspace_ready" || value?.event === "delivery_completed") {
      observeEvent(value);
      return;
    }
    if (value?.event !== "performer_turn_event") return;
    const record = recordFor(value.root_issue_id);
    if (!safeId(value.turn_id) || !safeId(value.performer_id)) {
      throw monitorError("e2e_turn_correlation_invalid");
    }
    if (value.event_kind === "turn_started") {
      if (activeTurn) throw monitorError("e2e_turn_overlap");
      if (record.performerId && record.performerId !== value.performer_id) {
        throw monitorError("e2e_root_readback_mismatch");
      }
      record.performerId = value.performer_id;
      const lane = PHASE_INDEX.get(record.phase) >= PHASE_INDEX.get("human-response-applied")
        ? "execution" : "planning";
      const laneTurns = lane === "planning" ? record.planningTurns : record.executionTurns;
      if (!laneTurns.includes(value.turn_id)) {
        laneTurns.push(value.turn_id);
        const sequence = lane === "planning" ? planningSequence : executionSequence;
        if (!sequence.includes(record.rootIssueId)) sequence.push(record.rootIssueId);
      }
      const order = lane === "planning" ? planningOrder() : executionOrder();
      const expected = expectedOrder();
      if (order.length > expected.length || order.some((id, index) => id !== expected[index])) {
        throw monitorError(lane === "planning"
          ? "e2e_planning_order_invalid" : "e2e_execution_order_invalid");
      }
      activeTurn = {
        rootIssueId: record.rootIssueId,
        performerId: value.performer_id,
        turnId: value.turn_id,
        lane,
        startedAt: now(),
      };
      record.pendingTurn = activeTurn;
      advance(record, lane === "planning" ? "planning-turn-started" : "execution-turn-started");
      progress(record);
      return;
    }
    if (value.event_kind === "turn_completed") {
      if (!activeTurn || activeTurn.turnId !== value.turn_id
        || activeTurn.rootIssueId !== record.rootIssueId
        || activeTurn.performerId !== value.performer_id) {
        throw monitorError("e2e_turn_correlation_invalid");
      }
      activeTurn = undefined;
      record.pendingTurn = undefined;
      record.lastTurnId = value.turn_id;
      record.lastCompletedFingerprint = record.fingerprint;
      record.lastTurnCompletedAt = now();
    }
  }

  function observeReadback(rootIssueId, state, {
    fingerprint,
    brokerEffectCount = 0,
    gitProgress = false,
  } = {}) {
    const record = recordFor(rootIssueId);
    if (state?.rootIssueId && state.rootIssueId !== rootIssueId) {
      throw monitorError("e2e_root_readback_mismatch");
    }
    if (state?.performerId && record.performerId && state.performerId !== record.performerId) {
      throw monitorError("e2e_root_readback_mismatch");
    }
    if (state?.performerId) record.performerId = state.performerId;
    const phase = readbackPhase(state, record);
    if (phase) advance(record, phase);
    const changed = fingerprint !== undefined && fingerprint !== record.fingerprint;
    const effect = Number.isSafeInteger(brokerEffectCount) && brokerEffectCount > 0;
    if (changed || effect || gitProgress) {
      record.fingerprint = fingerprint;
      record.noEffectTurns = 0;
      progress(record);
    }
    if (record.lastTurnCompletedAt !== undefined && !waitingState(state)) {
      if (fingerprint === record.lastCompletedFingerprint && !effect && !gitProgress) {
        record.noEffectTurns += 1;
      } else {
        record.noEffectTurns = 0;
      }
      record.lastCompletedFingerprint = fingerprint;
      record.lastCompletedTurn = undefined;
      record.lastTurnCompletedAt = undefined;
      if (record.noEffectTurns >= maxStalledTurns) {
        throw monitorError("e2e_root_progress_stalled");
      }
    }
    checkDeadlines();
    return state;
  }

  function startBoundary(name, rootIssueId) {
    if (!Object.hasOwn(configuredDeadlines, name)) throw monitorError("e2e_deadline_invalid");
    boundaries.set(boundaryKey(name, rootIssueId), { name, rootIssueId, startedAt: now() });
  }

  function completeBoundary(name, rootIssueId) {
    boundaries.delete(boundaryKey(name, rootIssueId));
  }

  function checkDeadlines() {
    const current = now();
    for (const boundary of boundaries.values()) {
      if (current - boundary.startedAt >= configuredDeadlines[boundary.name]) {
        throw monitorError(deadlineCode(boundary.name));
      }
    }
    if (current - startedAt >= configuredDeadlines.run) throw monitorError("e2e_run_timeout");
    if (activeTurn && current - activeTurn.startedAt >= configuredDeadlines.turn) {
      throw monitorError("e2e_root_turn_timeout");
    }
    for (const record of records.values()) {
      if (record.phase === "waiting-human"
        && current - record.phaseStartedAt >= configuredDeadlines.humanInput) {
        throw monitorError("e2e_human_input_timeout");
      }
      if (["working", "gating", "delivering"].includes(record.phase)
        && current - record.phaseStartedAt >= configuredDeadlines.rootCompletion) {
        throw monitorError("e2e_root_completion_timeout");
      }
      if (["planning-turn-started", "plan-published", "waiting-human"].includes(record.phase)
        && current - record.phaseStartedAt >= configuredDeadlines.planning) {
        throw monitorError("e2e_planning_timeout");
      }
    }
  }

  function heartbeat() {
    const current = now();
    if (current - lastHeartbeatAt < heartbeatIntervalMs) return;
    lastHeartbeatAt = current;
    log({
      event: "e2e_monitor_heartbeat",
      roots: [...records.values()].map((record) => ({
        root_issue_id: record.rootIssueId,
        phase: record.phase,
        phase_age_ms: Math.max(0, current - record.phaseStartedAt),
      })),
    });
  }

  function evidence() {
    return Object.freeze({
      activeTurn: activeTurn ? { ...activeTurn } : undefined,
      planningOrder: planningOrder(),
      executionOrder: executionOrder(),
      roots: Object.freeze([...records.values()].map((record) => Object.freeze({
        rootIssueId: record.rootIssueId,
        priority: record.priority,
        phase: record.phase,
        performerId: record.performerId,
        workspace: record.workspace ? { ...record.workspace } : undefined,
        delivery: record.delivery ? { ...record.delivery } : undefined,
        deliveryHead: record.delivery?.head,
        phaseAgeMs: Math.max(0, now() - record.phaseStartedAt),
        lastProgressAgeMs: Math.max(0, now() - record.lastProgressAt),
        planningTurnIds: [...record.planningTurns],
        executionTurnIds: [...record.executionTurns],
        noEffectTurns: record.noEffectTurns,
      }))),
    });
  }

  function recordFor(rootIssueId) {
    const record = records.get(rootIssueId);
    if (!record) throw monitorError("e2e_root_ownership_mismatch");
    return record;
  }

  function advance(record, phase) {
    if (PHASE_INDEX.get(phase) < PHASE_INDEX.get(record.phase)) {
      throw monitorError("e2e_root_phase_regression");
    }
    if (phase === record.phase) return;
    record.phase = phase;
    record.phaseStartedAt = now();
    log({
      event: "e2e_root_state_changed",
      root_issue_id: record.rootIssueId,
      phase,
    });
  }

  function progress(record) {
    record.lastProgressAt = now();
  }

  function expectedOrder() {
    return [...priorities].sort((left, right) => left.priority - right.priority)
      .map(({ rootIssueId }) => rootIssueId);
  }

  function planningOrder() {
    return [...planningSequence];
  }

  function executionOrder() {
    return [...executionSequence];
  }
}

function readbackPhase(state, record) {
  if (state?.phase === "root-todo") return "input-created";
  if (state?.phase === "planning") return "planning-turn-started";
  if (state?.phase === "awaiting-human") return "waiting-human";
  if (state?.phase === "working") {
    return PHASE_INDEX.get(record.phase) >= PHASE_INDEX.get("execution-turn-started")
      ? record.phase : "human-response-applied";
  }
  if (state?.phase === "gating") {
    return PHASE_INDEX.get(record.phase) >= PHASE_INDEX.get("work-evidence-confirmed")
      ? record.phase : "work-evidence-confirmed";
  }
  if (state?.phase === "delivering") {
    return PHASE_INDEX.get(record.phase) >= PHASE_INDEX.get("gate-checked")
      ? record.phase : "gate-checked";
  }
  if (state?.phase === "in-review") return "root-in-review";
  return undefined;
}

function waitingState(state) {
  return state?.phase === "awaiting-human" || state?.approvalState === "In Progress";
}

function boundaryKey(name, rootIssueId) {
  return name + ":" + (rootIssueId ?? "run");
}

function deadlineCode(name) {
  return {
    runtimeReady: "e2e_runtime_ready_timeout",
    rootDiscovery: "e2e_root_discovery_timeout",
    workspaceReady: "e2e_workspace_ready_timeout",
    allRoots: "e2e_all_roots_timeout",
    cleanup: "e2e_cleanup_timeout",
    humanInput: "e2e_human_input_timeout",
    rootCompletion: "e2e_root_completion_timeout",
  }[name] ?? "e2e_run_timeout";
}

function monitorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value);
}

function safeBranch(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function safeValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}
