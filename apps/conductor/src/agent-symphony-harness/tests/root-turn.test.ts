import assert from "node:assert/strict";
import test from "node:test";
import { decodeConductorPerformerRootTurnCommand } from "@symphony/contracts";

import type { V3RootRunView } from "../../root-workflow/api/Models.js";
import { RunAgentRootTurnUseCase } from "../internal/RunAgentRootTurnUseCase.js";

test("Harness fresh-reads scheduling facts and does not launch a waiting Human Root", async () => {
  let processCalls = 0;
  let readCalls = 0;
  const useCase = createUseCase({
    view: { ...rootView(), workflowNodes: [{
      issueId: "human-1", identifier: "SYM-2", parentIssueId: "root-1",
      siblingOrder: 1, kind: "human", state: "In Progress", title: "Input",
      description: "Choose", updatedAt: "2026-07-19T00:00:01Z",
    }] },
    onRead: () => { readCalls += 1; },
    onProcess: () => { processCalls += 1; },
  });

  assert.deepEqual(await useCase.run("root-1"), {
    kind: "not_started", readiness: "waiting_human",
  });
  assert.equal(readCalls, 1);
  assert.equal(processCalls, 0);
});

test("Harness runs one Root Turn and records observations only after read-back", async () => {
  const order: string[] = [];
  const useCase = createUseCase({
    onRead: () => { order.push("read"); },
    onProcess: () => { order.push("process"); },
    onObserve: () => { order.push("observe"); },
  });

  const result = await useCase.run("root-1");

  assert.equal(result.kind, "completed");
  assert.deepEqual(order, ["read", "process", "read", "observe"]);
  assert.equal("action" in result, false);
  assert.equal("targetIssueId" in result, false);
});

test("Root Turn command is the closed V3 shape without workflow actions", async () => {
  let command: unknown;
  await createUseCase({ onCommand(value) { command = value; } }).run("root-1");

  const decoded = decodeConductorPerformerRootTurnCommand(command as never) as unknown as Record<string, unknown>;
  for (const forbidden of ["turn_kind", "target_issue_id", "action", "work_issue_id"]) {
    assert.equal(forbidden in decoded, false);
  }
});

test("Root Turn process failure read-backs facts before recording failure", async () => {
  const order: string[] = [];
  const result = await createUseCase({
    processFailure: true,
    onRead: () => { order.push("read"); },
    onObserve: () => { order.push("observe"); },
  }).run("root-1");

  assert.equal(result.kind, "failed");
  assert.deepEqual(order, ["read", "read", "observe"]);
});

function createUseCase(options: {
  view?: V3RootRunView;
  onRead?(): void;
  onProcess?(): void;
  onObserve?(): void;
  onCommand?(value: unknown): void;
  processFailure?: boolean;
}) {
  return new RunAgentRootTurnUseCase({
    reconstruct: async () => { options.onRead?.(); return options.view ?? rootView(); },
    context: { async build() { return {
      json: "{}", markdown: "# Root", contextBytes: 6, contextDigest: "digest-1",
    }; } },
    profiles: { async get() { return {
      profileId: "profile-1", codexTurnSettings: {
        model: "gpt-5.2-codex", reasoningEffort: "high", isFastModeEnabled: false,
      }, executionPolicy: {
        sandboxMode: "workspace_write", commandAllowlist: [], commandDenylist: [],
      },
    }; } },
    broker: () => ({ async execute() { return { status: "read" }; } }),
    performer: { async runRootTurn(input) {
      options.onCommand?.(input.command);
      if (options.processFailure) throw new Error("provider unavailable");
      options.onProcess?.(); return { result: {
      protocol_version: "1", turn_id: "turn-1", root_issue_id: "root-1",
      performer_profile_id: "profile-1", performer_id: "conversation-1",
      context_digest: "digest-1", result_kind: "root_turn_completed",
      process_status: "completed", started_at: "2026-07-19T00:00:00Z",
      completed_at: "2026-07-19T00:00:01Z", wall_time_ms: 1000,
      context_bytes: 6, broker_calls: 0, mutations: 0,
    } }; } },
    observe: async () => { options.onObserve?.(); },
    turnId: () => "turn-1", now: () => "2026-07-19T00:00:00Z",
    limits: { maxWallTimeMs: 60_000, maxContextBytes: 1024,
      maxBrokerCalls: 8, maxMutations: 4 },
  });
}

function rootView(): V3RootRunView {
  return {
    root: { issueId: "root-1", identifier: "SYM-1", state: "In Progress",
      title: "Root", description: "Build", updatedAt: "2026-07-19T00:00:00Z" },
    conductorId: "conductor-1", resolvedProjectId: "project-1",
    managedComment: { conductorId: "conductor-1", performerProfileId: "profile-1",
      performerId: "conversation-1", deliveryBranch: "symphony/runs/sym-1" },
    profile: { profileId: "profile-1", readiness: "ready" },
    workflowNodes: [], workflowTreeComplete: true, blockerRelations: [],
    gitWorkspace: { branch: "symphony/runs/sym-1", worktreePath: "/work/root-1",
      head: "abc", status: [] }, attentionProblems: [],
  };
}
