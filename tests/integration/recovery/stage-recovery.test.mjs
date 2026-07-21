import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createChildEnvironment } from "../../../tools/e2e/config.mjs";
import { startConductorHarness } from "../../../tools/e2e/conductor-harness.mjs";
import { createSerializedWorkflowBoundary } from "../../../tools/e2e/serialized-workflow-boundary.mjs";

const run = promisify(execFile);

test("real Conductor ends an orphaned Work execution and creates a fresh retry after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-recovery-"));
  const repositoryRoot = path.join(root, "repository");
  const dataRoot = path.join(root, "conductor");
  const statePath = path.join(root, "linear-tree.json");
  const stageMarkerPath = path.join(dataRoot, "performer-profiles", "profile-1", "codex-home", "stage-starts.jsonl");
  await createRepository(repositoryRoot);
  const revision = (await run("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.trim();
  await writeProfile(dataRoot);
  await writeFile(statePath, JSON.stringify(serializedWorkTree(revision), null, 2));
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

  const first = await startConductor(environment("instance-1"), podium);
  const firstStage = await waitForStage(stageMarkerPath);
  assert.equal((await first.terminateAbruptly()).signal, "SIGKILL");
  killProcess(firstStage.pid);

  const second = await startConductor(environment("instance-2"), podium);
  await waitForTree(statePath, (tree) => {
    const records = tree.comments.map((comment) => comment.body);
    return tree.issues.find(({ issue_id }) => issue_id === "work-1")?.status_name === "Done"
      && records.some((body) => body.includes('"failure_code":"orphaned_execution"'))
      && records.some((body) => body.includes('"kind":"work_completion"'))
      && records.filter((body) => body.includes('"kind":"stage_execution"')).length === 2;
  });
  assert.equal((await second.terminateAbruptly()).signal, "SIGKILL");

  const finalTree = JSON.parse(await readFile(statePath, "utf8"));
  const executions = finalTree.comments.filter(({ body }) => body.includes('"kind":"stage_execution"'));
  const orphanTerminal = finalTree.comments.find(({ body }) => body.includes('"failure_code":"orphaned_execution"'));
  assert.equal(executions.length, 2);
  assert.ok(orphanTerminal);
  assert.ok(boundary.mutationKinds.includes("append_workflow_comment"));
  assert.ok(boundary.treeReadDigests.length >= 4);

  const worktree = path.join(dataRoot, "worktrees", "root-1");
  assert.equal((await run("git", ["-C", worktree, "branch", "--show-current"])).stdout.trim(), "symphony/runs/sym-1");
  assert.equal((await run("git", ["-C", worktree, "status", "--porcelain"])).stdout, "");
});

test("real Conductor resumes suspended Work only with a fresh Human answer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "symphony-human-recovery-"));
  const repositoryRoot = path.join(root, "repository");
  const dataRoot = path.join(root, "conductor");
  const statePath = path.join(root, "linear-tree.json");
  const invocationPath = path.join(dataRoot, "performer-profiles", "profile-1", "codex-home", "human-invocations.jsonl");
  await createRepository(repositoryRoot);
  const revision = (await run("git", ["-C", repositoryRoot, "rev-parse", "HEAD"])).stdout.trim();
  await writeProfile(dataRoot);
  await writeFile(statePath, JSON.stringify(serializedWorkTree(revision), null, 2));
  const performer = await writePerformer(root, "human");
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

  const first = await startConductor(environment("instance-1"), podium);
  await waitForTree(statePath, (tree) => {
    const records = tree.comments.map((comment) => comment.body);
    return tree.issues.find(({ issue_id }) => issue_id === "root-1")?.status_name === "Needs Info"
      && records.some((body) => body.includes('"kind":"human_action"'))
      && records.some((body) => body.includes('"outcome":"suspended"'));
  });
  assert.equal((await first.terminateAbruptly()).signal, "SIGKILL");

  await answerHuman(statePath);
  const second = await startConductor(environment("instance-2"), podium);
  await waitForTree(statePath, (tree) => tree.issues.find(({ issue_id }) => issue_id === "work-1")?.status_name === "Done");
  assert.equal((await second.terminateAbruptly()).signal, "SIGKILL");

  const invocations = (await readFile(invocationPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(invocations.length, 2);
  assert.notEqual(invocations[0].stage_execution_id, invocations[1].stage_execution_id);
  assert.notEqual(invocations[0].context_digest, invocations[1].context_digest);
  assert.deepEqual(invocations[0].resolved_human_input, []);
  assert.equal(invocations[1].resolved_human_input.length, 1);
  assert.equal(invocations[1].resolved_human_input[0].answer_or_decision.text, "Preserve the current compatibility behavior.");
  assert.equal(invocations[1].resolved_human_input[0].target_context_digest, invocations[0].context_digest);
});

async function startConductor(environment, podium) {
  return startConductorHarness({
    podium,
    environment,
    executable: process.execPath,
    arguments: ["--import", "tsx", path.resolve("apps/conductor/src/main.ts")],
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
  });
}

async function createRepository(repositoryRoot) {
  await run("git", ["init", "-b", "main", repositoryRoot]);
  await run("git", ["-C", repositoryRoot, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repositoryRoot, "config", "user.name", "Symphony Test"]);
  await mkdir(path.join(repositoryRoot, "apps", "conductor"), { recursive: true });
  await writeFile(path.join(repositoryRoot, "apps", "conductor", "README.md"), "recovery\n");
  await run("git", ["-C", repositoryRoot, "add", "."]);
  await run("git", ["-C", repositoryRoot, "commit", "-m", "initial"]);
}

async function writeProfile(dataRoot) {
  await mkdir(path.join(dataRoot, "performer-profiles"), { recursive: true });
  await writeFile(path.join(dataRoot, "performer-profiles", "profiles.json"), JSON.stringify({
    activeProfileId: "profile-1",
    profiles: [{
      profileId: "profile-1", displayName: "Serialized fixture", backendKind: "codex", authenticationMethod: "chatgpt",
      codexTurnSettings: { model: "gpt-5", reasoningEffort: "high", isFastModeEnabled: true },
      executionPolicy: { sandboxMode: "workspace_write", commandAllowlist: [], commandDenylist: [] },
      createdAt: "2026-07-22T00:00:00.000Z", updatedAt: "2026-07-22T00:00:00.000Z",
    }],
  }, null, 2));
}

async function writePerformer(root, mode = "orphan") {
  const script = path.join(root, "performer-fixture.cjs");
  const executable = path.join(root, "performer-fixture");
  await writeFile(script, `
const fs = require("node:fs");
const path = require("node:path");
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes("--profile-control")) {
  let data = "";
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => {
    const request = JSON.parse(data.trim().split("\\n")[0]);
    process.stdout.write(JSON.stringify({ protocol_version: "1", request_id: request.request_id, profile_id: request.profile_id, kind: "profile_status", readiness: "ready" }) + "\\n");
  });
} else {
  const request = JSON.parse(fs.readFileSync(args[args.indexOf("--request") + 1], "utf8"));
  const resultPath = args[args.indexOf("--result") + 1];
  const workspaceRoot = args[args.indexOf("--workspace-root") + 1];
  const workspaceRevision = request.repository_context.workspace_revision;
  const execution = request.stage_execution;
  const target = request.target;
  const marker = path.join(process.env.CODEX_HOME, mode === "human" ? "human-invocations.jsonl" : "stage-starts.jsonl");
  const firstInvocation = !fs.existsSync(marker);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.appendFileSync(marker, JSON.stringify({
    pid: process.pid,
    stage_execution_id: execution.stage_execution_id,
    context_digest: request.context_digest,
    resolved_human_input: request.workflow_context.resolved_human_input,
  }) + "\\n");
  if (mode === "human" && firstInvocation) {
    fs.writeFileSync(resultPath, JSON.stringify({
      protocol_version: request.protocol_version, stage_execution_id: execution.stage_execution_id, stage: execution.stage,
      root_issue_id: target.root_issue_id, cycle_issue_id: target.cycle_issue_id, node_issue_id: target.node_issue_id,
      context_digest: request.context_digest, completed_at: "2026-07-22T00:00:00.000Z",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
      outcome: { kind: "suspended", request_kind: "needs_info", question_or_proposal: "Please confirm the compatibility behavior.", reason: "The compatibility behavior is ambiguous.", impact: "Work cannot continue until it is confirmed." },
    }));
  } else if (mode === "human") {
    fs.writeFileSync(resultPath, JSON.stringify({
      protocol_version: request.protocol_version, stage_execution_id: execution.stage_execution_id, stage: execution.stage,
      root_issue_id: target.root_issue_id, cycle_issue_id: target.cycle_issue_id, node_issue_id: target.node_issue_id,
      context_digest: request.context_digest, completed_at: "2026-07-22T00:00:02.000Z",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
      outcome: { kind: "work_completed", summary: "Resumed after the Human answer.", changed_paths: [], checks: [], observed_workspace_revision: workspaceRevision },
    }));
  } else if (firstInvocation) {
    setInterval(() => {}, 1_000);
  } else {
    const changedPath = "apps/conductor/recovered.txt";
    fs.writeFileSync(path.join(workspaceRoot, changedPath), "recovered\\n");
    fs.writeFileSync(resultPath, JSON.stringify({
      protocol_version: request.protocol_version, stage_execution_id: execution.stage_execution_id, stage: execution.stage,
      root_issue_id: target.root_issue_id, cycle_issue_id: target.cycle_issue_id, node_issue_id: target.node_issue_id,
      context_digest: request.context_digest, completed_at: "2026-07-22T00:00:00.000Z",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 2 },
      outcome: { kind: "work_completed", summary: "Recovered the interrupted Work execution.", changed_paths: [changedPath],
        checks: [{ check_key: "recovery-check", command_or_method: "fixture", outcome: "passed", summary: "Recovery check passed.", artifact_revision: workspaceRevision }],
        observed_workspace_revision: workspaceRevision },
    }));
  }
}
`, { encoding: "utf8", mode: 0o600 });
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { encoding: "utf8", mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

async function answerHuman(statePath) {
  const tree = JSON.parse(await readFile(statePath, "utf8"));
  const root = tree.issues.find(({ issue_id }) => issue_id === "root-1");
  const status = tree.status_catalog.find(({ name }) => name === "In Progress");
  if (!root || !status) throw new Error("human_answer_root_missing");
  Object.assign(root, {
    status_id: status.status_id,
    status_name: status.name,
    status_category: status.category,
    status_position: status.position,
    remote_version: "human-answer-root-version",
  });
  tree.comments.push({
    comment_id: "human-answer-1",
    issue_id: "work-1",
    body: "Preserve the current compatibility behavior.",
    remote_version: "human-answer-1-version",
    updated_at: "2026-07-22T00:00:01.000Z",
  });
  await writeFile(statePath, JSON.stringify(tree, null, 2), "utf8");
}

function serializedWorkTree(revision) {
  const statuses = [
    ["Draft", "backlog"], ["Todo", "unstarted"], ["Planning", "started"], ["Sealed", "started"], ["Executing", "started"], ["Verifying", "started"], ["In Progress", "started"], ["In Review", "started"], ["Needs Approval", "started"], ["Needs Info", "started"], ["Inconclusive", "started"], ["Escalated", "started"], ["Succeeded", "completed"], ["Changes Required", "completed"], ["Done", "completed"], ["Canceled", "canceled"], ["Failed", "canceled"],
  ].map(([name, category], position) => ({ status_id: `status-${position}`, name, category, position }));
  const status = (name) => statuses.find((candidate) => candidate.name === name);
  const issue = (issue_id, issue_kind, status_name, order, parent_issue_id) => ({
    issue_id, identifier: issue_id === "root-1" ? "SYM-1" : issue_id, project_id: "project-1",
    ...(parent_issue_id ? { parent_issue_id } : {}), status_id: status(status_name).status_id, status_name,
    status_category: status(status_name).category, status_position: status(status_name).position, order,
    depth: issue_kind === "root" ? 0 : issue_kind === "cycle" ? 1 : 2, title: issue_id, description: issue_id,
    issue_kind, remote_version: `${issue_id}:version`, updated_at: "2026-07-22T00:00:00.000Z",
    ...((issue_kind === "cycle" ? { managed_marker: "root-1:cycle:cycle-1" } : issue_kind === "plan" ? { managed_marker: "root-1:plan:bootstrap" } : issue_kind === "work" ? { managed_marker: "root-1:work:cycle-1:one" } : issue_kind === "verify" ? { managed_marker: "root-1:verify:cycle-1" } : {})),
  });
  const record = (issue_id, comment_id, value) => ({ comment_id, issue_id, body: `<!-- symphony managed-record\n${JSON.stringify(value)}\n-->`, managed_marker: `root-1:${comment_id}`, remote_version: `${comment_id}:version`, updated_at: "2026-07-22T00:00:00.000Z" });
  const criterion = { criterion_key: "root", statement: "The Root is delivered.", verification_method: "test" };
  return {
    root_issue_id: "root-1", status_catalog: statuses,
    issues: [issue("root-1", "root", "In Progress", 0), issue("cycle-1", "cycle", "Executing", 1, "root-1"), issue("plan-1", "plan", "Done", 1, "cycle-1"), issue("work-1", "work", "Todo", 2, "cycle-1"), issue("verify-1", "verify", "Todo", 3, "cycle-1")],
    comments: [
      record("root-1", "ownership", { kind: "root_ownership", version: 1, root_issue_id: "root-1", conductor_id: "conductor-1", performer_profile_id: "profile-1", delivery_branch: "symphony/runs/sym-1", owner_generation: "generation-1" }),
      record("cycle-1", "cycle-marker", { kind: "cycle_marker", version: 1, root_issue_id: "root-1", cycle_key: "cycle-1", trigger: "initial", baseline_revision: revision }),
      record("plan-1", "plan-marker", { kind: "node_marker", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_key: "plan-1", node_kind: "plan", plan_contract_digest: "digest-1" }),
      record("plan-1", "plan-contract", { kind: "plan_contract", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1", plan_contract_digest: "digest-1", objective_summary: "Recover the interrupted Work execution.", included_scope: ["apps/conductor"], excluded_scope: ["packages/podium"], acceptance_criteria: [criterion], work_nodes: [{ work_key: "one", title: "Recover Work", description: "Recover the interrupted Work node.", acceptance_criteria: [criterion], dependency_work_keys: [] }], verify_node: { title: "Verify recovery", acceptance_criteria: [criterion], required_checks: [] } }),
      record("work-1", "work-marker", { kind: "node_marker", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_key: "one", node_kind: "work", plan_contract_digest: "digest-1" }),
      record("verify-1", "verify-marker", { kind: "node_marker", version: 1, root_issue_id: "root-1", cycle_issue_id: "cycle-1", node_key: "verify-1", node_kind: "verify", plan_contract_digest: "digest-1" }),
    ],
    relations: [{ relation_id: "plan-work", relation_kind: "blocks", source_issue_id: "plan-1", target_issue_id: "work-1" }, { relation_id: "work-verify", relation_kind: "blocks", source_issue_id: "work-1", target_issue_id: "verify-1" }],
    observed_at: "2026-07-22T00:00:00.000Z",
  };
}

async function waitForStage(markerPath) {
  const value = await waitFor(async () => {
    try {
      const lines = (await readFile(markerPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return lines[0];
    } catch { return undefined; }
  });
  return value;
}

async function waitForTree(statePath, predicate) {
  await waitFor(async () => {
    try {
      return predicate(JSON.parse(await readFile(statePath, "utf8")));
    } catch {
      return false;
    }
  });
}

async function waitFor(read) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("stage_recovery_observation_timeout");
}

function killProcess(pid) {
  try { process.kill(pid, "SIGKILL"); } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
