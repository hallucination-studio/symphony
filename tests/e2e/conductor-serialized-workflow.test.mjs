import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createChildEnvironment } from "../../tools/e2e/config.mjs";
import {
  createSerializedWorkflowBoundary,
} from "../../tools/e2e/serialized-workflow-boundary.mjs";
import { startConductorHarness } from "../../tools/e2e/conductor-harness.mjs";

const run = promisify(execFile);

test("real Conductor rebuilds a serialized terminal Root with a real Git worktree after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-serialized-conductor-"));
  const repositoryRoot = path.join(root, "repository");
  const dataRoot = path.join(root, "conductor");
  const statePath = path.join(root, "linear-tree.json");
  await createRepository(repositoryRoot);
  await writeProfile(dataRoot);
  await writeFile(statePath, JSON.stringify(serializedTerminalTree(), null, 2));
  const performer = await writePerformer(root);
  const boundary = createSerializedWorkflowBoundary({ statePath });
  const podium = { handler: boundary.handler, observeExit: () => {}, close: () => {} };
  const environment = (instanceId) => createChildEnvironment({ additions: {
    SYMPHONY_PRIVATE_IPC_FD: "3",
    SYMPHONY_INSTANCE_ID: instanceId,
    SYMPHONY_BINDING_ID: "binding-1",
    SYMPHONY_CONDUCTOR_ID: "conductor-1",
    SYMPHONY_CONDUCTOR_SHORT_HASH: "abc123def456",
    SYMPHONY_LINEAR_INSTALLATION_ID: "serialized-fixture:organization-1",
    SYMPHONY_ORGANIZATION_ID: "organization-1",
    SYMPHONY_REPOSITORY_HANDLE: "repository-1",
    SYMPHONY_REPOSITORY_ROOT: repositoryRoot,
    SYMPHONY_BASE_BRANCH: "main",
    SYMPHONY_CONDUCTOR_DATA_ROOT: dataRoot,
    SYMPHONY_PERFORMER_EXECUTABLE: performer,
    SYMPHONY_CYCLE_DELAY_MS: "1000",
  } });

  const first = await startConductorHarness({
    podium,
    environment: environment("instance-1"),
    executable: process.execPath,
    arguments: ["--import", "tsx", path.resolve("apps/conductor/src/main.ts")],
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });
  await first.waitForObservation((value) => value.kind === "conductor_runtime_report" && value.status === "ready");
  assert.equal((await first.terminateAbruptly()).signal, "SIGKILL");

  const second = await startConductorHarness({
    podium,
    environment: environment("instance-2"),
    executable: process.execPath,
    arguments: ["--import", "tsx", path.resolve("apps/conductor/src/main.ts")],
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });
  await second.waitForObservation((value) => value.kind === "conductor_runtime_report" && value.status === "ready");
  assert.equal((await second.terminateAbruptly()).signal, "SIGKILL");

  assert.ok(boundary.treeReadDigests.length >= 2);
  assert.equal(new Set(boundary.treeReadDigests).size, 1);
  assert.ok(boundary.requestKinds.filter((kind) => kind === "get_workflow_issue_tree").length >= 2);
  const worktree = path.join(dataRoot, "worktrees", "root-1");
  assert.equal((await run("git", ["-C", worktree, "branch", "--show-current"])).stdout.trim(), "symphony/runs/sym-1");
  assert.equal((await run("git", ["-C", worktree, "status", "--porcelain"])).stdout, "");
});

async function createRepository(repositoryRoot) {
  await run("git", ["init", "-b", "main", repositoryRoot]);
  await run("git", ["-C", repositoryRoot, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repositoryRoot, "config", "user.name", "Symphony Test"]);
  await writeFile(path.join(repositoryRoot, "README.md"), "serialized\n");
  await run("git", ["-C", repositoryRoot, "add", "README.md"]);
  await run("git", ["-C", repositoryRoot, "commit", "-m", "initial"]);
}

async function writeProfile(dataRoot) {
  await mkdir(path.join(dataRoot, "performer-profiles"), { recursive: true });
  await writeFile(path.join(dataRoot, "performer-profiles", "profiles.json"), JSON.stringify({
    activeProfileId: "profile-1",
    profiles: [{
      profileId: "profile-1",
      displayName: "Serialized fixture",
      backendKind: "codex",
      authenticationMethod: "chatgpt",
      codexTurnSettings: { model: "gpt-5", reasoningEffort: "high", isFastModeEnabled: true },
      executionPolicy: { sandboxMode: "workspace_write", commandAllowlist: [], commandDenylist: [] },
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    }],
  }, null, 2));
}

async function writePerformer(root) {
  const script = path.join(root, "profile-control.js");
  const executable = path.join(root, "performer-fixture");
  await writeFile(script, [
    "const chunks = [];",
    "process.stdin.on('data', (chunk) => chunks.push(chunk));",
    "process.stdin.on('end', () => {",
    "  const request = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());",
    "  process.stdout.write(JSON.stringify({ protocol_version: '1', request_id: request.request_id, profile_id: request.profile_id, kind: 'profile_status', readiness: 'ready' }) + '\\n');",
    "});",
  ].join("\n"));
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
  await chmod(executable, 0o700);
  return executable;
}

function serializedTerminalTree() {
  const statuses = [
    ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"], ["Sealed", "started"],
    ["Executing", "started"], ["Verifying", "started"], ["In Progress", "started"], ["In Review", "started"],
    ["Needs Approval", "started"], ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"],
    ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"], ["Canceled", "canceled"], ["Failed", "canceled"], ["Duplicate", "canceled"],
  ].map(([name, category], position) => ({ status_id: `status-${position}`, name, category, position }));
  const status = (name) => statuses.find((candidate) => candidate.name === name);
  const issue = (issue_id, issue_kind, status_name, order, depth, parent_issue_id, managed_marker) => ({
    issue_id, identifier: issue_id === "root-1" ? "SYM-1" : issue_id,
    project_id: "project-1", ...(parent_issue_id ? { parent_issue_id } : {}),
    status_id: status(status_name).status_id, status_name, status_category: status(status_name).category,
    status_position: status(status_name).position, order, depth, title: issue_id, description: issue_id,
    ...(managed_marker ? { managed_marker } : {}), issue_kind, remote_version: `${issue_id}:version`,
    updated_at: "2026-07-22T00:00:00.000Z",
  });
  return {
    root_issue_id: "root-1",
    status_catalog: statuses,
    issues: [
      issue("root-1", "root", "In Review", 0, 0),
      issue("cycle-1", "cycle", "Canceled", 1, 1, "root-1", "root-1:cycle:cycle-1"),
      issue("plan-1", "plan", "Todo", 1, 2, "cycle-1", "root-1:plan:bootstrap"),
    ],
    comments: [
      comment("root-1", "root-1:ownership", { kind: "root_ownership", version: 1, root_issue_id: "root-1", conductor_id: "conductor-1", performer_profile_id: "profile-1", delivery_branch: "symphony/runs/sym-1", owner_generation: "generation-1" }),
      comment("cycle-1", "root-1:record:cycle", { kind: "cycle_marker", version: 1, root_issue_id: "root-1", cycle_key: "cycle-1", trigger: "initial", baseline_revision: "0123456789012345678901234567890123456789" }),
      comment("plan-1", "root-1:record:plan", { kind: "node_marker", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_key: "plan-1", node_kind: "plan", plan_contract_digest: "pending-plan-contract" }),
    ],
    relations: [],
    observed_at: "2026-07-22T00:00:00.000Z",
  };
}

function comment(issue_id, managed_marker, record) {
  return {
    comment_id: managed_marker, issue_id, body: `<!-- symphony managed-record\n${JSON.stringify(record)}\n-->`,
    managed_marker, remote_version: `${managed_marker}:version`, updated_at: "2026-07-22T00:00:00.000Z",
  };
}
