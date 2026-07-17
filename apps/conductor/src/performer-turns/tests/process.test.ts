import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PerformerTurnProcessImpl } from "../internal/PerformerTurnProcessImpl.js";
import type { PerformerInvocation } from "../internal/GlobalPerformerLane.js";

const command = {
  protocol_version: "1",
  turn_id: "turn-1",
  turn_kind: "plan",
  root_issue_id: "root-1",
  performer_profile_id: "profile-1",
  codex_turn_settings: {
    model: "gpt-5",
    reasoning_effort: "high",
    is_fast_mode_enabled: true,
  },
  turn_input_hash: "hash-1",
  workspace_root: "/bounded/worktree",
  started_at: "2026-07-17T00:00:00Z",
  hard_deadline_at: "2026-07-17T00:10:00Z",
  body: {
    root_issue: { title: "Root", description: "Build V1" },
    current_tree: [],
  },
};

test("Performer process writes a validated request and collects a validated result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  let invocation: PerformerInvocation | undefined;
  const process = new PerformerTurnProcessImpl(
    {
      async run(value: PerformerInvocation) {
        invocation = value;
        const resultPath = value.arguments[value.arguments.indexOf("--turn-result-path") + 1]!;
        await writeFile(resultPath, JSON.stringify({
          protocol_version: "1",
          turn_id: "turn-1",
          turn_kind: "plan",
          result_kind: "plan_ready",
          root_issue_id: "root-1",
          performer_profile_id: "profile-1",
          performer_id: "conversation-1",
          turn_input_hash: "hash-1",
          completed_at: "2026-07-17T00:01:00Z",
          body: { summary: "Plan", nodes: [] },
        }));
        return { stdout: "", stderr: "" };
      },
    },
    {
      runtimeRoot: root,
      executable: "performer",
      environment: () => ({ CODEX_HOME: "/isolated/profile" }),
      deadlineMs: 1_000,
    },
  );

  const result = await process.run({
    turnId: "turn-1",
    profileId: "profile-1",
    workspaceRoot: root,
    command,
  });

  assert.equal((result as { result_kind: string }).result_kind, "plan_ready");
  assert.equal(invocation?.environment?.CODEX_HOME, "/isolated/profile");
  const requestPath = path.join(root, "turn-1", "turn-request.json");
  assert.equal(JSON.parse(await readFile(requestPath, "utf8")).turn_id, "turn-1");
});

test("Performer process blocks on a missing result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-turn-"));
  const process = new PerformerTurnProcessImpl(
    { async run() { return { stdout: "", stderr: "" }; } },
    {
      runtimeRoot: root,
      executable: "performer",
      environment: () => ({}),
      deadlineMs: 1_000,
    },
  );

  await assert.rejects(
    process.run({
      turnId: "turn-1",
      profileId: "profile-1",
      workspaceRoot: root,
      command,
    }),
    /performer_result_missing/,
  );
});
