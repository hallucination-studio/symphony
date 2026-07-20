import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeConductorPerformerRootTurnCommand } from "@symphony/contracts";
import { RootConversationLifecycle } from "../../../apps/conductor/dist/agent-symphony-harness/internal/RootConversationLifecycle.js";
import { RunAgentRootTurnUseCase } from "../../../apps/conductor/dist/agent-symphony-harness/internal/RunAgentRootTurnUseCase.js";
import { ScopedAgentCommandBrokerImpl } from "../../../apps/conductor/dist/agent-symphony-harness/internal/ScopedAgentCommandBrokerImpl.js";
import { AgentRootContextBuilder } from "../../../apps/conductor/dist/agent-symphony-harness/internal/AgentRootContextBuilder.js";
import { BoundedLinearTreeContextImpl } from "../../../apps/conductor/dist/linear-tree/internal/BoundedLinearTreeContextImpl.js";
import { GlobalPerformerLane } from "../../../apps/conductor/dist/performer-turns/internal/GlobalPerformerLane.js";
import { SubprocessPerformerProcessImpl } from "../../../apps/conductor/dist/performer-turns/internal/SubprocessPerformerProcessImpl.js";

test("one Root persists its Conversation before one V3 business Turn", async () => {
  const order = [];
  const view = rootView();
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-flow-"));
  const performer = await createFlowPerformer(runtimeRoot);
  const rootWorkspace = { ...workspace(), worktreePath: runtimeRoot };
  const lifecycle = new RootConversationLifecycle({
    conductorId: "conductor-1", baseBranch: "main", now: () => "2026-07-19T00:00:00Z",
    requestId: () => "open-1", bootstrapDeadlineMs: 60_000,
    profiles: { async activeReadyProfile() { return profile(); } },
    workspaces: { async ensureWorkspace() { order.push("workspace"); return rootWorkspace; } },
    performer: { async openRootConversation(input) {
      order.push("bootstrap");
      return performer.openRootConversation(input);
    } },
    claims: {
      async compareAndSetClaim({ managedComment }) { order.push("cas");
        view.managedComment = managedComment; view.managedCommentRemote = {
          commentId: "comment-1", updatedAt: "2026-07-19T00:00:01Z" };
        view.root.state = "In Progress"; view.gitWorkspace = { branch: rootWorkspace.branch,
          worktreePath: runtimeRoot, head: "abc", status: [] }; return "applied"; },
      async reconstruct() { order.push("claim-read-back"); return view; },
    },
  });
  assert.equal((await lifecycle.claim(view)).kind, "ready");

  const commands = [];
  const writes = [];
  const linearMutations = [];
  const createBroker = (turnId) => new ScopedAgentCommandBrokerImpl({
    conductorId: "conductor-1", turnId, rootIssueId: "root-1",
    performerId: "conversation-1",
    linear: {
      async readFreshRootScope() { return scope(); },
      async read() { return { summary: "fresh Root Context" }; },
      async mutate(input) {
        writes.push(input.command);
        linearMutations.push(input);
        if (input.command === "linear.issue.create_child" && input.args.kind === "human") {
          view.workflowNodes = [humanNode("In Progress")];
        }
        return { kind: "applied", summary: "read back" };
      },
    },
    async readGitHead() { return "abc"; }, workspace: rootWorkspace,
    git: {
      async commit() { writes.push("git.commit"); return { kind: "committed", commit: "def" }; },
      async inspect() { throw new Error("unused"); }, async diff() { throw new Error("unused"); },
      async checks() { throw new Error("unused"); },
    },
    delivery: { async deliver() { writes.push("root.deliver");
      return { kind: "remote_branch", branch: workspace().branch }; } },
    deliveryContext: { baseBranch: "main", title: "SYM-1", body: "Delivery",
      treeDigest: "tree-1", checksDigest: "checks-1" },
  });
  const turns = new RunAgentRootTurnUseCase({
    reconstruct: async () => { order.push("turn-read"); return view; },
    context: { async build(input) {
      order.push("context");
      return rootContextBuilder(view).build(input);
    } },
    profiles: { async get() { return profile(); } },
    broker: ({ turnId }) => createBroker(turnId),
    performer: { async runRootTurn(input) {
      order.push("turn-process"); commands.push(input.command);
      if (commands.length === 1) {
        await input.broker.execute({ protocol_version: "1", request_id: "broker-first",
          turn_id: input.command.turn_id, root_issue_id: "root-1",
          performer_id: "conversation-1", command: "linear.issue.create_child",
          args: { parent_issue_id: "root-1", kind: "human", title: "Approval",
            description: "Confirm the plan", write_id: "human-write",
            expected_remote_version: "version-1", expected_git_head: "abc" } });
      }
      return performer.runRootTurn(input);
    } },
    observe: async () => { order.push("observe"); },
    turnId: (() => { let sequence = 0; return () => `turn-${++sequence}`; })(),
    now: () => "2026-07-19T00:00:01Z", limits: { maxWallTimeMs: 60_000,
      maxContextBytes: 65_536, maxBrokerCalls: 10, maxMutations: 8 },
  });
  const humanYield = await turns.run("root-1");
  assert.equal(humanYield.kind, "completed", JSON.stringify(humanYield));
  assert.equal(humanYield.result.yield_reason, "waiting_human");
  assert.deepEqual(view.workflowNodes, [humanNode("In Progress")]);
  assert.deepEqual(await turns.run("root-1"), {
    kind: "not_started", readiness: "waiting_human",
  });
  view.workflowNodes = [{ ...humanNode("Done"), answer: "Approved" }];
  assert.equal((await turns.run("root-1")).kind, "completed");
  assert.equal(commands.length, 2);
  for (const command of commands) decodeConductorPerformerRootTurnCommand(command);
  const resumed = commands[1];
  assert.equal(resumed.performer_id, commands[0].performer_id);
  assert.equal(resumed.context_digest, createHash("sha256")
    .update(resumed.root_context.markdown, "utf8").digest("hex"));
  assert.match(resumed.root_context.json, /"issue_id":"root-1"/u);
  assert.match(resumed.root_context.json, /"answer":"Approved"/u);
  assert.equal(commands[0].root_context.json.includes('"answer":"Approved"'), false);
  assert.deepEqual(linearMutations.filter(({ command }) =>
    command === "linear.issue.create_child").map(({ args }) =>
    ({ kind: args.kind, title: args.title })), [
    { kind: "human", title: "Approval" },
    { kind: "work", title: "Implementation" },
    { kind: "rework", title: "[Rework] Root Gate Findings" },
  ]);
  assert.deepEqual(order, ["workspace", "bootstrap", "cas", "claim-read-back",
    "turn-read", "context", "turn-process", "turn-read", "observe",
    "turn-read", "turn-read", "context", "turn-process", "turn-read", "observe"]);
  assert.deepEqual(writes, [
    "linear.issue.create_child", "linear.issue.create_child",
    "linear.issue.create_child", "linear.status.set", "linear.comment.create",
    "git.commit", "root.deliver",
  ]);
});

test("one Root rejects stale retry and clears only its acknowledged Retry Block", async () => {
  const view = claimedView();
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-retry-"));
  const performer = await createFailedBootstrapPerformer(runtimeRoot);
  let blocked;
  let cleared = 0;
  let reconstructCalls = 0;
  const lifecycle = new RootConversationLifecycle({
    conductorId: "conductor-1", baseBranch: "main", now: () => "2026-07-19T00:00:03Z",
    requestId: () => "retry-1", bootstrapDeadlineMs: 60_000,
    profiles: { async fixedReadyProfile() { return profile(); } },
    workspaces: { async ensureWorkspace() { return workspace(); } },
    performer,
    claims: {
      async writeRetryBlock(input) { blocked = input.retryBlock; return "applied"; },
      async appendRetryProblem() {}, async clearRetryBlock() { cleared += 1; return "applied"; },
      async reconstruct() {
        reconstructCalls += 1;
        return reconstructCalls === 4 ? claimedView() : blockedView(blocked);
      },
    },
  });

  assert.deepEqual(await lifecycle.retry(view, "conversation-old"), {
    kind: "abandoned", reason: "root_conversation_stale",
  });
  assert.deepEqual(await lifecycle.retry(view, "conversation-1"), {
    kind: "rejected", reason: "root_retry_blocked",
  });
  assert.deepEqual(blocked, { expectedPerformerId: "conversation-1",
    failureCode: "provider_auth_unavailable", observedAt: "2026-07-19T00:00:03Z" });
  assert.deepEqual(await lifecycle.acknowledge("root-1", "2026-07-19T00:00:02Z"), {
    kind: "rejected", reason: "root_retry_acknowledgement_stale",
  });
  assert.deepEqual(await lifecycle.acknowledge("root-1", "2026-07-19T00:00:03Z"), {
    kind: "acknowledged",
  });
  assert.equal(cleared, 1);
});

test("a Performer subprocess invokes the installed broker CLI over inherited FDs", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-v3-cli-"));
  const executable = path.join(runtimeRoot, "fake-performer");
  await symlink(path.resolve(".venv/bin/symphony"), path.join(runtimeRoot, "symphony"));
  await writeFile(executable, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const correlation = { protocol_version: "1", turn_id: get("--turn-id"),
  root_issue_id: get("--root-issue-id"), performer_profile_id: get("--performer-profile-id"),
  performer_id: get("--performer-id"), context_digest: get("--context-digest") };
process.stdout.write(JSON.stringify({ ...correlation, sequence: 0,
  occurred_at: "2026-07-19T00:00:01Z", body: { kind: "protocol_ready" } }) + "\\n");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const command = JSON.parse(input);
  process.env.SYMPHONY_TURN_ID = command.turn_id;
  process.env.SYMPHONY_ROOT_ISSUE_ID = command.root_issue_id;
  process.env.SYMPHONY_PERFORMER_ID = command.performer_id;
  const invoked = spawnSync("symphony", ["linear", "status", "set", "--args-json",
    JSON.stringify({ issue_id: "root-1", status: "In Progress",
      expected_remote_version: "version-1", expected_git_head: "abc" })],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", 3, 4] });
  if (invoked.status !== 0) { process.stderr.write(invoked.stderr); process.exit(invoked.status || 1); }
  const brokerResult = JSON.parse(invoked.stdout);
  if (brokerResult.status !== "applied") process.exit(3);
  const result = { ...correlation, result_kind: "root_turn_completed",
    completed_at: "2026-07-19T00:00:02Z", turn_usage: { wall_time_ms: 1,
      context_bytes: Buffer.byteLength(command.root_context.json) +
        Buffer.byteLength(command.root_context.markdown), provider_tokens: 0,
      broker_calls: 0, mutations: 0 } };
  const resultPath = get("--root-turn-result-path");
  fs.writeFileSync(resultPath + ".tmp", JSON.stringify(result));
  fs.renameSync(resultPath + ".tmp", resultPath);
});
`);
  await chmod(executable, 0o700);

  const observed = [];
  const processBoundary = new SubprocessPerformerProcessImpl(new GlobalPerformerLane(), {
    runtimeRoot,
    executable,
    environment: () => ({ PATH: process.env.PATH }),
    startupDeadlineMs: 5_000,
    cancellationGraceMs: 500,
  });
  const output = await processBoundary.runRootTurn({
    profileId: "profile-1",
    workspaceRoot: runtimeRoot,
    command: rootTurnCommand(runtimeRoot),
    broker: {
      async execute(request) {
        observed.push(request);
        return { protocol_version: request.protocol_version, request_id: request.request_id,
          turn_id: request.turn_id, root_issue_id: request.root_issue_id,
          performer_id: request.performer_id, status: "applied", summary: "Read back." };
      },
    },
  });

  assert.equal(observed.length, 1);
  assert.equal(observed[0].command, "linear.status.set");
  assert.deepEqual(output.result.turn_usage, { wall_time_ms: 1, context_bytes: 23,
    provider_tokens: 0, broker_calls: 1, mutations: 1 });
});

function profile() { return { profileId: "profile-1", readiness: "ready",
  codexTurnSettings: { model: "gpt-5.4", reasoningEffort: "high",
    isFastModeEnabled: false }, executionPolicy: { sandboxMode: "workspace_write",
    commandAllowlist: [], commandDenylist: [] } }; }
function workspace() { return { rootIssueId: "root-1", branch: "symphony/runs/sym-1",
  worktreePath: "/work/root-1" }; }
function scope() { return { root_issue_id: "root-1", conductor_id: "conductor-1",
  performer_id: "conversation-1", terminal: false, issues: [
    { issue_id: "root-1", updated_at: "version-1" },
    { issue_id: "child-1", parent_issue_id: "root-1", updated_at: "version-2" },
  ] }; }
async function createFlowPerformer(runtimeRoot) {
  const executable = path.join(runtimeRoot, "fake-performer");
  await symlink(path.resolve(".venv/bin/symphony"), path.join(runtimeRoot, "symphony"));
  await writeFile(executable, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
if (args.includes("--open-conversation-request-path")) {
  const command = JSON.parse(fs.readFileSync(get("--open-conversation-request-path"), "utf8"));
  fs.writeFileSync(get("--open-conversation-result-path"), JSON.stringify({
    protocol_version: command.protocol_version, request_id: command.request_id,
    performer_profile_id: command.performer_profile_id, performer_id: "conversation-1",
    completed_at: "2026-07-19T00:00:01Z" }));
}
let correlation = args.includes("--open-conversation-request-path") ? undefined : {
  protocol_version: "1", turn_id: get("--turn-id"), root_issue_id: get("--root-issue-id"),
  performer_profile_id: get("--performer-profile-id"), performer_id: get("--performer-id"),
  context_digest: get("--context-digest") };
let resultPath = get("--root-turn-result-path");
let input = "";
let startBuffer = "";
function ready() {
  process.stdout.write(JSON.stringify({ ...correlation, sequence: 0,
    occurred_at: "2026-07-19T00:00:01Z", body: { kind: "protocol_ready" } }) + "\\n");
}
if (correlation) ready();
process.stdin.on("data", (chunk) => {
  if (correlation) { input += chunk; return; }
  startBuffer += chunk;
  const newline = startBuffer.indexOf("\\n");
  if (newline < 0) return;
  const start = JSON.parse(startBuffer.slice(0, newline));
  correlation = { protocol_version: start.protocol_version, turn_id: start.turn_id,
    root_issue_id: start.root_issue_id, performer_profile_id: start.performer_profile_id,
    performer_id: start.performer_id, context_digest: start.context_digest };
  resultPath = start.result_path;
  input += startBuffer.slice(newline + 1);
  startBuffer = "";
  ready();
});
process.stdin.on("end", () => {
  const command = JSON.parse(input);
  if (!command.root_context.markdown.includes("## trusted_harness") ||
      !command.root_context.json.includes('"issue_id":"root-1"') ||
      command.performer_id !== "conversation-1") {
    process.exit(4);
  }
  const awaitingHuman = !command.root_context.json.includes('"answer":"Approved"');
  const commands = awaitingHuman ? [] : [
    [["linear", "issue", "create-child"], { parent_issue_id: "root-1", kind: "work",
      title: "Implementation", description: "Build the change", write_id: "work-write",
      expected_remote_version: "version-1", expected_git_head: "abc" }],
    [["linear", "issue", "create-child"], { parent_issue_id: "root-1", kind: "rework",
      title: "[Rework] Root Gate Findings", description: "Address the failed Gate", write_id: "rework-write",
      expected_remote_version: "version-1", expected_git_head: "abc" }],
    [["linear", "status", "set"], { issue_id: "child-1", status: "Done",
      expected_remote_version: "version-2", expected_git_head: "abc" }],
    [["linear", "comment", "create"], { issue_id: "child-1",
      body: "Human approval observed; Work and Gate passed.", write_id: "write-1",
      expected_remote_version: "version-2", expected_git_head: "abc" }],
    [["git", "commit"], { issue_id: "child-1", expected_remote_version: "version-2",
      expected_head: "abc" }],
    [["root", "deliver"], { expected_root_version: "version-1", expected_head: "abc" }],
  ];
  for (const [commandPath, commandArgs] of commands) {
    const invoked = spawnSync("symphony", [...commandPath, "--args-json",
      JSON.stringify(commandArgs)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", 3, 4] });
    if (invoked.status !== 0 || JSON.parse(invoked.stdout).status !== "applied") process.exit(5);
  }
  const result = { ...correlation, result_kind: "root_turn_completed",
    yield_reason: awaitingHuman ? "waiting_human" : "delivered",
    completed_at: "2026-07-19T00:00:02Z", turn_usage: { wall_time_ms: 1,
      context_bytes: Buffer.byteLength(command.root_context.json) +
        Buffer.byteLength(command.root_context.markdown), provider_tokens: 0,
      broker_calls: 0, mutations: 0 } };
  fs.writeFileSync(resultPath + ".tmp", JSON.stringify(result));
  fs.renameSync(resultPath + ".tmp", resultPath);
});
`);
  await chmod(executable, 0o700);
  return new SubprocessPerformerProcessImpl(new GlobalPerformerLane(), {
    runtimeRoot, executable, environment: () => ({ PATH: process.env.PATH }),
    startupDeadlineMs: 5_000, cancellationGraceMs: 500,
  });
}
async function createFailedBootstrapPerformer(runtimeRoot) {
  const executable = path.join(runtimeRoot, "failed-bootstrap-performer");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const command = JSON.parse(fs.readFileSync(get("--open-conversation-request-path"), "utf8"));
fs.writeFileSync(get("--open-conversation-result-path"), JSON.stringify({
  protocol_version: command.protocol_version, request_id: command.request_id,
  performer_profile_id: command.performer_profile_id,
  error_code: "provider_auth_unavailable",
  sanitized_reason: "Authentication unavailable.", retryable: false,
  completed_at: "2026-07-19T00:00:03Z" }));
`);
  await chmod(executable, 0o700);
  return new SubprocessPerformerProcessImpl(new GlobalPerformerLane(), {
    runtimeRoot, executable, environment: () => ({ PATH: process.env.PATH }),
    startupDeadlineMs: 5_000, cancellationGraceMs: 500,
  });
}
function rootContextBuilder(view) {
  return new AgentRootContextBuilder(new BoundedLinearTreeContextImpl({
    async readRootContext() {
      return {
        root: contextSection([{ issue_id: "root-1", title: "Build V3" }], 1),
        tree: contextSection(view.workflowNodes.map((node) => ({
          issue_id: node.issueId, parent_issue_id: "root-1", state: node.state,
          kind: node.kind, title: node.title,
        })), 16),
        ancestors: contextSection([], 8),
        comments: contextSection(view.workflowNodes.flatMap((node) => node.answer
          ? [{ human_issue_id: node.issueId, answer: node.answer }]
          : []), 16),
        relations: contextSection([{ issue_id: "work-1", blocks: [] }], 16),
      };
    },
  }));
}
function humanNode(state) {
  return { issueId: "human-1", identifier: "SYM-2", parentIssueId: null,
    siblingOrder: 0, kind: "human", humanKind: "plan_approval", state,
    title: "Approval", description: "Confirm the plan",
    updatedAt: "2026-07-19T00:00:02Z", origin: "symphony",
    managedMarker: "human-write" };
}
function contextSection(items, cap) {
  return { items, cap, hasMore: false, includeErrors: [] };
}
function rootTurnCommand(workspaceRoot) { return {
  protocol_version: "1", turn_id: "turn-1", root_issue_id: "root-1",
  performer_profile_id: "profile-1", performer_id: "conversation-1",
  codex_turn_settings: { model: "gpt-5.2-codex", reasoning_effort: "high",
    is_fast_mode_enabled: false },
  execution_policy: { sandbox_mode: "workspace_write", command_allowlist: [],
    command_denylist: [] },
  root_context: { json: '{"root":"root-1"}', markdown: "# Root" },
  context_digest: "digest-1", command_channel: { kind: "workspace_framed_channel",
    metadata_path: ".symphony/agent-command/metadata.json",
    request_path: ".symphony/agent-command/request.fifo",
    response_path: ".symphony/agent-command/response.fifo" }, workspace_root: workspaceRoot,
  started_at: "2026-07-19T00:00:00Z", turn_limits: { max_wall_time_ms: 60_000,
    max_context_bytes: 1_024, max_broker_calls: 10, max_mutations: 2 },
}; }
function claimedView() { const view = rootView(); view.root.state = "In Progress";
  view.managedComment = { conductorId: "conductor-1", performerProfileId: "profile-1",
    performerId: "conversation-1", deliveryBranch: workspace().branch };
  view.managedCommentRemote = { commentId: "comment-1", updatedAt: "2026-07-19T00:00:02Z" };
  view.gitWorkspace = { branch: workspace().branch, worktreePath: workspace().worktreePath,
    head: "abc", status: [] }; return view; }
function blockedView(retryBlock) { const view = claimedView();
  view.managedComment = { ...view.managedComment, retryBlock }; return view; }
function rootView() { return { root: { issueId: "root-1", identifier: "SYM-1",
  state: "Todo", title: "Build V3", description: "", updatedAt: "2026-07-19T00:00:00Z" },
  conductorId: "conductor-1", resolvedProjectId: "project-1",
  profile: { profileId: "profile-1", readiness: "ready" }, workflowNodes: [],
  workflowTreeComplete: true, blockerRelations: [], attentionProblems: [] }; }
