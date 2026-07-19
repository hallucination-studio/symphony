import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { agentCommandAllowed } from "../api/PerformerProfileStoreInterface.js";
import { FilePerformerProfileStoreImpl } from "../internal/FilePerformerProfileStoreImpl.js";

const now = "2026-07-19T00:00:00.000Z";

test("Profile store defaults and atomically round-trips execution policy", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "symphony-profiles-"));
  const store = new FilePerformerProfileStoreImpl(dataRoot);
  const created = await store.create({
    profileId: "profile-1",
    displayName: "Default",
    backendKind: "codex",
    authenticationMethod: "chatgpt",
    codexTurnSettings: {
      model: "gpt-5",
      reasoningEffort: "high",
      isFastModeEnabled: true,
    },
    now,
  });
  assert.deepEqual(created.executionPolicy, {
    sandboxMode: "workspace_write",
    commandAllowlist: [],
    commandDenylist: [],
  });

  const executionPolicy = {
    sandboxMode: "read_only" as const,
    commandAllowlist: [{ executable: "git", argvPrefix: ["status"] }],
    commandDenylist: [{ executable: "git", argvPrefix: ["status", "--short"] }],
  };
  await store.update({
    profileId: "profile-1",
    displayName: "Restricted",
    codexTurnSettings: created.codexTurnSettings,
    executionPolicy,
    now,
  });

  assert.deepEqual((await store.list()).profiles[0]?.executionPolicy, executionPolicy);
});

test("Profile store reports an invalid saved execution policy without rewriting it", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "symphony-profiles-"));
  const directory = path.join(dataRoot, "performer-profiles");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "profiles.json"), JSON.stringify({
    profiles: [{
      profileId: "profile-1",
      displayName: "Invalid",
      backendKind: "codex",
      authenticationMethod: "chatgpt",
      codexTurnSettings: {
        model: "gpt-5",
        reasoningEffort: "high",
        isFastModeEnabled: true,
      },
      executionPolicy: {
        sandboxMode: "invented",
        commandAllowlist: [],
        commandDenylist: [],
      },
      createdAt: now,
      updatedAt: now,
    }],
  }));
  const store = new FilePerformerProfileStoreImpl(dataRoot);

  await assert.rejects(store.list(), /profile_execution_policy_invalid/u);
});

test("Agent command policy gives exact deny prefixes precedence over allow rules", () => {
  const policy = {
    sandboxMode: "workspace_write" as const,
    commandAllowlist: [{ executable: "git", argvPrefix: ["status"] }],
    commandDenylist: [{ executable: "git", argvPrefix: ["status", "--short"] }],
  };

  assert.equal(agentCommandAllowed(policy, "git", ["status"]), true);
  assert.equal(agentCommandAllowed(policy, "git", ["status", "--short"]), false);
  assert.equal(agentCommandAllowed(policy, "git", ["status", "--short", "--branch"]), false);
  assert.equal(agentCommandAllowed(policy, "git", ["diff"]), false);
  assert.equal(agentCommandAllowed(policy, "npm", ["test"]), false);
});
