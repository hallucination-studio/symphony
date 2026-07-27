import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { StageTurnInput } from "../../root-reconciliation/api/RootReconciliationContracts.js";
import { PersistentPerformerAgentChannelFactory } from "../internal/PerformerAgentChannel.js";
import { SessionPerformerAgentClientImpl } from "../internal/SessionPerformerAgentClientImpl.js";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const PROBE = path.join(ROOT, "tests/integration/agent-boundary/performer-context-probe.py");
const PYTHON = path.join(ROOT, ".venv/bin/python");
type ProbeEvent = {
  event: string;
  pid: number;
  role: string;
  handle: string;
  request_id?: string;
  update?: { kind: string; changes?: Array<Record<string, unknown>> };
};

test("real Performer processes isolate roles, fresh-open ambiguous continuity, and retain no checkpoint", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-context-boundary-"));
  const recordPath = path.join(directory, "events.jsonl");
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const first = client(recordPath);
  context.after(async () => first.cancelAndReap());

  await first.executePlanTurn(stageInput("plan", "plan-request-1", "plan-turn-1", "plan-execution-1"));
  await first.executeWorkTurn(stageInput("work", "work-request-1", "work-turn-1", "work-execution-1"));
  await first.executeVerifyTurn(stageInput("verify", "verify-request-1", "verify-turn-1", "verify-execution-1"));
  const changedPlan = stageInput("plan", "plan-request-2", "plan-turn-2", "plan-execution-2");
  changedPlan.tree.issues[2] = { ...changedPlan.tree.issues[2]!, remote_version: "plan-v2" };
  await first.executePlanTurn(changedPlan);

  const ambiguous = stageInput("plan", "plan-request-3", "plan-turn-3", "plan-execution-3");
  ambiguous.goal = "force acceptance unknown";
  const failed = await first.executePlanTurn(ambiguous);
  assert.equal(failed.outcome.kind, "execution_failed");
  await first.executePlanTurn(stageInput("plan", "plan-request-4", "plan-turn-4", "plan-execution-4"));

  await first.cancelAndReap();
  const second = client(recordPath);
  context.after(async () => second.cancelAndReap());
  await second.executePlanTurn(stageInput("plan", "plan-request-5", "plan-turn-5", "plan-execution-5"));
  await second.cancelAndReap();

  const events = await probeEvents(recordPath);
  const firstTurns = events.filter((event) => event.event === "turn" && event.request_id !== "plan-request-5");
  const roleHandles = new Map(firstTurns.slice(0, 3).map((event) => [event.role, event.handle]));
  assert.equal(roleHandles.size, 3);
  assert.equal(new Set(roleHandles.values()).size, 3);

  const planDelta = events.find((event) => event.request_id === "plan-request-2")!;
  assert.equal(planDelta.update?.kind, "delta");
  assert.equal("sources" in planDelta.update!, false);
  assert.deepEqual(planDelta.update?.changes?.map((change) => change.kind), ["replacement"]);

  assert.equal(events.find((event) => event.request_id === "plan-request-3")!.update?.kind, "delta");
  assert.equal(events.find((event) => event.request_id === "plan-request-4")!.update?.kind, "initial");
  const beforeRestart = events.find((event) => event.request_id === "plan-request-4")!;
  const afterRestart = events.find((event) => event.request_id === "plan-request-5")!;
  assert.equal(afterRestart.update?.kind, "initial");
  assert.notEqual(afterRestart.pid, beforeRestart.pid);
  assert.notEqual(afterRestart.handle, beforeRestart.handle);
});

function client(recordPath: string): SessionPerformerAgentClientImpl {
  return new SessionPerformerAgentClientImpl({
    executable: PYTHON,
    environment: () => ({
      PATH: process.env.PATH,
      PYTHONPATH: path.join(ROOT, "apps/performer/src"),
      SYMPHONY_CONTEXT_PROBE_RECORD: recordPath,
    }),
    channelFactory: new PersistentPerformerAgentChannelFactory([PROBE]),
    deadlineMs: 30_000,
  });
}

async function probeEvents(recordPath: string): Promise<ProbeEvent[]> {
  return (await readFile(recordPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as ProbeEvent);
}

function stageInput(
  role: "plan" | "work" | "verify",
  requestId: string,
  roleTurnId: string,
  stageExecutionId: string,
): StageTurnInput {
  const issue = (issueId: string, depth: number, remoteVersion: string) => ({
    issue_id: issueId, identifier: `SYM-${depth + 1}`, project_id: "project-1",
    ...(depth > 0 ? { parent_issue_id: depth === 1 ? "root-1" : "cycle-1" } : {}),
    status_id: "todo", status_name: "Todo", status_category: "unstarted" as const,
    status_position: 1, order: 1, depth, title: issueId, description: `${issueId} description`,
    labels: [], is_archived: false, remote_version: remoteVersion,
    created_at: "2026-07-23T00:00:00Z", updated_at: "2026-07-23T00:00:00Z",
  });
  return {
    protocolVersion: 1, requestId, stageExecutionId, roleSessionId: `${role}-session`, roleTurnId,
    rootIssueId: "root-1", cycleIssueId: "cycle-1", targetIssueId: `${role}-1`, role,
    goal: "execute the selected role", requiredEvidenceRefs: [],
    tree: {
      root_issue_id: "root-1",
      status_catalog: [{ status_id: "todo", name: "Todo", category: "unstarted", position: 1 }],
      issues: [issue("root-1", 0, "root-v1"), issue("cycle-1", 1, "cycle-v1"), issue(`${role}-1`, 2, `${role}-v1`)],
      comments: [], relations: [], attachments: [], activities: [], source_manifest: [],
      coverage: { is_complete: true, omissions: [] }, observed_at: "2026-07-23T00:00:00Z",
    },
    git: { head: "head-1", branch: "main", status: { items: [], returned: 0, cap: 32, has_more: false, partial: false } },
    profileId: "profile-1",
    modelSettings: { model: "gpt", reasoningEffort: "medium", isFastModeEnabled: false },
    observedTreeDigest: "tree-1",
    executionPolicy: {
      sandbox_mode: role === "work" ? "workspace_write" : "read_only",
      workspace_access: role === "work" ? "read_write" : "read_only",
    },
  };
}
