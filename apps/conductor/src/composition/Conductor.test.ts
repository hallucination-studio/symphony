import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { CritiqueEnvelope } from "../contracts/cycle.js";
import type { PerformerLaunchRequest } from "../contracts/performer.js";
import type { RootReconcileDecision, RootReconcileRequest } from "../contracts/root.js";
import { parseRootState } from "../contracts/root.js";
import { parseRootWorkspace } from "../contracts/workspace.js";
import type { MarkdownText } from "../contracts/validation.js";
import { CycleRunner } from "../cycle-runner/CycleRunner.js";
import { InMemoryLinearGateway } from "../linear/InMemoryLinearGateway.js";
import { parseRootDescription, renderRootDescription } from "../linear/LinearRootState.js";
import type { Performer } from "../performer/api/Performer.js";
import { Conductor } from "./Conductor.js";

const exec = promisify(execFile);
const DESCRIPTION_TIMESTAMP = "2026-08-05 00:00:00 GMT+08:00";

async function scenario() {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-conductor-"));
  const workspacePath = path.join(base, "workspace");
  const runDirectory = path.join(base, "run");
  await Promise.all([mkdir(workspacePath), mkdir(runDirectory)]);
  const gateway = new InMemoryLinearGateway({
    states: [
      { id: "todo-id", name: "Waiting", type: "unstarted", team_id: "team-id" },
      { id: "active-id", name: "Doing", type: "started", team_id: "team-id" },
      { id: "review-id", name: "In Review", type: "started", team_id: "team-id" },
      { id: "needs-human-id", name: "Needs Human", type: "started", team_id: "team-id" },
      { id: "completed-id", name: "Finished", type: "completed", team_id: "team-id" },
      { id: "canceled-id", name: "Abandoned", type: "canceled", team_id: "team-id" },
    ],
    issues: [{
      id: "root-id", identifier: "ENG-1", title: "Build strict parser", description: "Reject ambiguity.",
      url: "https://linear.invalid/ENG-1", status: "todo", status_id: "todo-id",
      parent_id: null, team_id: "team-id", creator_id: "user-id",
    } as never],
  });
  return {
    gateway, workspacePath, runDirectory,
    workspace: parseRootWorkspace({ workspace_path: workspacePath, run_directory: runDirectory, root_branch: "root/ENG-1" }),
  };
}

function scriptedReconciler(decisions: readonly RootReconcileDecision[], requests: RootReconcileRequest[]) {
  let index = 0;
  return {
    async reconcile(request: RootReconcileRequest) {
      requests.push(request);
      const decision = decisions[index++];
      if (decision === undefined) throw new Error("unexpected_reconcile");
      return { decision };
    },
  };
}

function scriptedPerformer(audits: readonly CritiqueEnvelope[], launches: PerformerLaunchRequest[]): Performer {
  let auditIndex = 0;
  return {
    async launch(request) {
      launches.push(request);
      if (request.sandbox === "workspace_write") {
        if (request.final_response_path === undefined) throw new Error("unexpected_execute");
        await writeFile(request.final_response_path, "## Artist Result\n\nImplementation complete.\n", "utf8");
        return {
          launch_status: "exited", exit_code: 0, duration_ms: 2,
          final_response_ref: request.final_response_path,
          diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
          diagnostic_stderr_ref: request.diagnostic_stderr_path,
        };
      }
      const critique = audits[auditIndex++];
      if (critique === undefined || request.final_response_path === undefined) throw new Error("unexpected_audit");
      const markdown = [
        "```json",
        JSON.stringify(critique),
        "```",
        "",
        critique.verdict === "process_error"
          ? "The Critic process could not complete its semantic audit."
          : "The fresh read-only Critic inspected the complete workspace.",
      ].join("\n");
      await writeFile(request.final_response_path, markdown, "utf8");
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 3,
        final_response_ref: request.final_response_path,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
}

async function setRootState(
  world: Awaited<ReturnType<typeof scenario>>,
  state: ReturnType<typeof parseRootState>,
  report?: string,
): Promise<void> {
  const root = await world.gateway.get_issue("root-id");
  await world.gateway.update_issue_description(
    root.id,
    renderRootDescription(root.description, state, report, DESCRIPTION_TIMESTAMP),
  );
}

async function rootProjection(world: Awaited<ReturnType<typeof scenario>>) {
  return parseRootDescription((await world.gateway.get_issue("root-id")).description);
}

function makeStaleRootReadback(
  world: Awaited<ReturnType<typeof scenario>>,
  description: MarkdownText,
): void {
  const getIssue = world.gateway.get_issue.bind(world.gateway);
  world.gateway.get_issue = async (issueRef: string) => {
    const issue = await getIssue(issueRef);
    return issue.id === "root-id" ? { ...issue, description } : issue;
  };
}

const cycle = (objective: string): RootReconcileDecision => ({
  kind: "create_cycle",
  cycle: { objective, acceptance: `${objective} is independently verified`, boundaries: "Parser and tests only" } as never,
  report: [
    "### Why Continue", "A bounded task remains incomplete.", "",
    "### Evidence", "The trusted Root state requires another independently audited change.", "",
    "### Next Cycle", objective,
  ].join("\n") as never,
});

const complete = (summary: string): RootReconcileDecision => ({
  kind: "complete", summary: summary as never,
  delivery: { kind: "branch", branch: "root/ENG-1" },
  report: [
    "### Overview", summary, "",
    "### File Changes", "#### Created", "- None", "", "#### Updated", "- None", "", "#### Deleted", "- None", "",
    "### Line Changes", "+0 / -0 lines", "",
    "### Verification", "The latest Critic provides the trusted evidence.", "",
    "### Run Metrics", "Duration: 0ms", "Total tokens: Unknown",
  ].join("\n") as never,
});

const needsHuman = (
  reason: string,
  replyDisposition?: "accepted" | "rejected",
): RootReconcileDecision => ({
  kind: "needs_human", reason: reason as never,
  questions: [{
    question: "Which boundary should Symphony use?",
    options: [
      { key: "A", label: "Service-owned", consequence: "The service owns the transaction." },
      { key: "B", label: "Caller-owned", consequence: "The caller owns the transaction." },
    ],
  }] as never,
  ...(replyDisposition === undefined ? {} : { reply_disposition: replyDisposition }),
  ...(replyDisposition !== "accepted" ? {} : {
    architecture_decisions: [{
      title: "Choose the service-owned boundary",
      decision: "Use the service-owned transaction boundary.",
      rationale: "The human reply selected the service-owned option.",
      consequences: ["The service owns transaction coordination."],
    }] as never,
  }),
  report: [
    "### Reason", reason, "",
    "### Question", "What explicit direction should Symphony apply?", "",
    "### Next Step", "Wait for a new human-authored Root comment.",
  ].join("\n") as never,
});

test("runs rejected repair then accepted Cycle and publishes only trusted Critic state", async () => {
  const world = await scenario();
  const reconcileRequests: RootReconcileRequest[] = [];
  const launches: PerformerLaunchRequest[] = [];
  const rootStatusesAtReconcile: string[] = [];
  const decisions = scriptedReconciler([
    cycle("Attempt strict parsing"), cycle("Repair strict parsing"),
    complete("All trusted checks pass"),
  ], reconcileRequests);
  let reconcileCount = 0;
  const reconciler = {
    async reconcile(request: RootReconcileRequest) {
      rootStatusesAtReconcile.push((await world.gateway.get_issue("ENG-1")).status_id);
      if (reconcileCount === 0) {
        assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "todo-id");
      }
      reconcileCount += 1;
      return decisions.reconcile(request);
    },
  };
  const rolePerformer = scriptedPerformer([
    {
      verdict: "incomplete", task_state_markdown: "Ambiguity remains", pending_finding: "Reject ambiguous token",
    } as never,
    {
      verdict: "accepted", task_state_markdown: "Strict parser behavior is verified",
    } as never,
  ], launches);
  const performer: Performer = {
    async launch(request, signal) {
      if (request.sandbox === "workspace_write") {
        assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "active-id");
      }
      return rolePerformer.launch(request, signal);
    },
  };
  const runner = new CycleRunner({
    gateway: world.gateway, artistPerformer: performer, criticPerformer: performer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const conductor = new Conductor({
    gateway: world.gateway, workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" }, reconciler, cycleRunner: runner,
    workspace: world.workspace, maxCycles: 3,
  });

  assert.deepEqual(await conductor.run("ENG-1"), { status: "done", delivery: { kind: "branch", branch: "root/ENG-1" } });
  assert.equal(launches.length, 4);
  assert.equal((await world.gateway.get_issue("ENG-1")).status, "completed");
  const state = (await rootProjection(world)).state;
  assert.notEqual(state, undefined);
  if (state === undefined) throw new Error("missing_root_state");
  assert.equal(state.task_state_markdown, "Strict parser behavior is verified");
  assert.equal(
    state.latest_critique !== undefined && "pending_finding" in state.latest_critique
      ? state.latest_critique.pending_finding
      : undefined,
    undefined,
  );
  assert.equal(state.delivery?.kind, "branch");
  assert.deepEqual(rootStatusesAtReconcile, ["todo-id", "review-id", "review-id"]);
  assert.deepEqual(reconcileRequests[1]?.root_state.latest_critique, {
    verdict: "incomplete",
    task_state_markdown: "Ambiguity remains",
    pending_finding: "Reject ambiguous token",
    artifact_url: "https://linear.invalid/upload/fake-upload-1",
  });
  assert.deepEqual(state.latest_critique, {
    verdict: "accepted",
    task_state_markdown: "Strict parser behavior is verified",
    artifact_url: "https://linear.invalid/upload/fake-upload-2",
  });
  assert.equal(reconcileRequests[0]?.root.description, "Reject ambiguity.");
  assert.equal((await world.gateway.list_root_comments_after("root-id")).length, 0);
});

test("preserves the visible Root status until Reconcile requests human input", async () => {
  const world = await scenario();
  await world.gateway.update_issue_status("root-id", "active-id");
  const statuses: string[] = [];
  const conductor = new Conductor({
    gateway: world.gateway,
    workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: {
      reconcile: async () => {
        statuses.push((await world.gateway.get_issue("ENG-1")).status_id);
        return { decision: needsHuman("Require an explicit boundary") };
      },
    },
    cycleRunner: {} as CycleRunner,
    workspace: world.workspace,
    maxCycles: 1,
  });

  assert.deepEqual(await conductor.run("ENG-1"), {
    status: "needs_human",
    reason: "Require an explicit boundary",
  });
  assert.deepEqual(statuses, ["active-id"]);
  assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "needs-human-id");
  const comments = await world.gateway.list_root_comments_after("root-id");
  assert.equal(comments.length, 1);
  assert.match(comments[0]?.body ?? "", /^# Symphony Harness: Human Action\n/u);
  assert.equal((await rootProjection(world)).state?.human_action?.comment_id, comments[0]?.id);
});

test("final Inbox input cancels completion and enters the next frozen Cycle", async () => {
  const world = await scenario();
  const reconcilerRequests: RootReconcileRequest[] = [];
  const baseReconciler = scriptedReconciler([
    complete("Initially complete"),
    cycle("Apply late Root input"),
    needsHuman("Stop after proving the fence"),
  ], reconcilerRequests);
  let calls = 0;
  const reconciler = {
    async reconcile(request: RootReconcileRequest) {
      calls += 1;
      const decision = await baseReconciler.reconcile(request);
      if (calls === 1) {
        await world.gateway.create_comment("root-id", "Late user requirement");
      }
      return decision;
    },
  };
  const launches: PerformerLaunchRequest[] = [];
  const rolePerformer = scriptedPerformer([{
    task_state_markdown: "Late input is verified",
  } as never], launches);
  const runner = new CycleRunner({
    gateway: world.gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const conductor = new Conductor({
    gateway: world.gateway, workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" }, reconciler, cycleRunner: runner,
    workspace: world.workspace, maxCycles: 2,
  });

  assert.deepEqual(await conductor.run("ENG-1"), { status: "needs_human", reason: "Stop after proving the fence" });
  assert.equal(launches.length, 2);
  assert.equal(reconcilerRequests[1]?.new_root_comments[0]?.body, "Late user requirement");
});

test("NeedsHuman resumes only after a direct Human Action reply", async () => {
  const world = await scenario();
  const rolePerformer = scriptedPerformer([], []);
  const runner = new CycleRunner({
    gateway: world.gateway, artistPerformer: rolePerformer, criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const stopped = new Conductor({
    gateway: world.gateway, workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: scriptedReconciler([needsHuman("Choose an API boundary")], []),
    cycleRunner: runner,
    workspace: world.workspace, maxCycles: 1,
  });
  assert.deepEqual(await stopped.run("ENG-1"), { status: "needs_human", reason: "Choose an API boundary" });
  assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "needs-human-id");
  assert.equal((await world.gateway.list_root_comments_after("root-id")).length, 1);

  let reconciles = 0;
  const withoutInput = new Conductor({
    gateway: world.gateway, workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: { reconcile: async () => { reconciles += 1; throw new Error("unexpected_reconcile"); } },
    cycleRunner: runner,
    workspace: world.workspace, maxCycles: 1,
  });
  assert.deepEqual(await withoutInput.run("ENG-1"), { status: "needs_human", reason: "Choose an API boundary" });
  assert.equal(reconciles, 0);
  assert.equal((await world.gateway.list_root_comments_after("root-id")).length, 1);

  const action = (await world.gateway.list_root_comments_after("root-id"))[0];
  assert.notEqual(action, undefined);
  const reply = await world.gateway.create_comment_reply("root-id", action?.id ?? "missing", "Use the existing parser boundary.");
  const requests: RootReconcileRequest[] = [];
  const withInput = new Conductor({
    gateway: world.gateway, workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: scriptedReconciler([needsHuman("Input acknowledged", "accepted")], requests),
    cycleRunner: runner,
    workspace: world.workspace, maxCycles: 1,
  });
  assert.deepEqual(await withInput.run("ENG-1"), { status: "needs_human", reason: "Input acknowledged" });
  assert.deepEqual(requests[0]?.new_root_comments, []);
  assert.equal(requests[0]?.human_action_replies[0]?.body, "Use the existing parser boundary.");
  assert.deepEqual(world.gateway.reactions, [{
    id: "fake-reaction-1", reply_id: reply.id, emoji: "white_check_mark",
  }]);
  const comments = await world.gateway.list_root_comments_after("root-id");
  assert.equal(comments.length, 2);
  assert.equal((await rootProjection(world)).state?.human_action?.comment_id, comments.at(-1)?.id);
  assert.equal((await rootProjection(world)).state?.architecture_decisions[0]?.id, "ADR-001");
});

test("rejects one whole Root reply batch and asks one actionable follow-up", async () => {
  const world = await scenario();
  const runner = {} as CycleRunner;
  const workflow = { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" };
  const stopped = new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([needsHuman("Choose an API boundary")], []),
    cycleRunner: runner, workspace: world.workspace, maxCycles: 1,
  });
  await stopped.run("ENG-1");
  const action = (await world.gateway.list_root_comments_after("root-id"))[0];
  assert.notEqual(action, undefined);
  const firstReply = await world.gateway.create_comment_reply("root-id", action?.id ?? "missing", "Maybe use either boundary.");
  const secondReply = await world.gateway.create_comment_reply("root-id", action?.id ?? "missing", "I am not sure yet.");
  const requests: RootReconcileRequest[] = [];
  const rejected = new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([needsHuman("The reply does not choose one boundary.", "rejected")], requests),
    cycleRunner: runner, workspace: world.workspace, maxCycles: 1,
  });

  assert.deepEqual(await rejected.run("ENG-1"), {
    status: "needs_human", reason: "The reply does not choose one boundary.",
  });
  assert.deepEqual(requests[0]?.new_root_comments, []);
  assert.deepEqual(requests[0]?.human_action_replies.map(({ id }) => id), [firstReply.id, secondReply.id]);
  assert.deepEqual(world.gateway.reactions.map(({ reply_id, emoji }) => ({ reply_id, emoji })), [
    { reply_id: firstReply.id, emoji: "x" },
    { reply_id: secondReply.id, emoji: "x" },
  ]);
  const comments = await world.gateway.list_root_comments_after("root-id");
  assert.equal(comments.filter(({ body }) => body.startsWith("# Symphony Harness: Human Action")).length, 1);
  const thread = await world.gateway.list_comment_replies_after(action?.id ?? "missing");
  assert.match(thread.at(-1)?.body ?? "", /^# Symphony Harness: Human Action Follow-up[\s\S]*The reply does not choose one boundary\./u);
  assert.equal((await rootProjection(world)).state?.human_action?.reply_cursor, secondReply.id);

  let reconciles = 0;
  const restarted = new Conductor({
    gateway: world.gateway, workflow,
    reconciler: { reconcile: async () => { reconciles += 1; throw new Error("unexpected_reconcile"); } },
    cycleRunner: runner, workspace: world.workspace, maxCycles: 1,
  });
  assert.deepEqual(await restarted.run("ENG-1"), {
    status: "needs_human", reason: "The reply does not choose one boundary.",
  });
  assert.equal(reconciles, 0);
  assert.equal((await world.gateway.list_comment_replies_after(action?.id ?? "missing")).length, thread.length);
});

test("accepts a Root reply once before the final completion read", async () => {
  const world = await scenario();
  const workflow = { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" };
  await new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([needsHuman("Choose an API boundary")], []),
    cycleRunner: {} as CycleRunner, workspace: world.workspace, maxCycles: 1,
  }).run("ENG-1");
  const action = (await world.gateway.list_root_comments_after("root-id"))[0];
  assert.notEqual(action, undefined);
  const reply = await world.gateway.create_comment_reply("root-id", action?.id ?? "missing", "Use the service-owned boundary.");
  const requests: RootReconcileRequest[] = [];
  const acceptedCompletion = {
    ...complete("The selected boundary is already verified."),
    reply_disposition: "accepted",
    architecture_decisions: [{
      title: "Use service ownership",
      decision: "Use the service-owned transaction boundary.",
      rationale: "The human selected service ownership.",
      consequences: ["The service coordinates the transaction."],
    }] as never,
  } as RootReconcileDecision;
  const result = await new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([acceptedCompletion], requests),
    cycleRunner: {} as CycleRunner, workspace: world.workspace, maxCycles: 1,
  }).run("ENG-1");

  assert.deepEqual(result, { status: "done", delivery: { kind: "branch", branch: "root/ENG-1" } });
  assert.equal(requests.length, 1);
  assert.deepEqual(world.gateway.reactions.map(({ reply_id, emoji }) => ({ reply_id, emoji })), [
    { reply_id: reply.id, emoji: "white_check_mark" },
  ]);
  assert.equal((await rootProjection(world)).state?.human_action, undefined);
  assert.equal((await rootProjection(world)).state?.architecture_decisions[0]?.source_reply_ids[0], reply.id);
});

test("fails closed when an accepted Architecture Decision is missing from provider read-back", async () => {
  const world = await scenario();
  const workflow = { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" };
  await new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([needsHuman("Choose an API boundary")], []),
    cycleRunner: {} as CycleRunner, workspace: world.workspace, maxCycles: 1,
  }).run("ENG-1");
  const action = (await world.gateway.list_root_comments_after("root-id"))[0];
  assert.notEqual(action, undefined);
  const reply = await world.gateway.create_comment_reply("root-id", action?.id ?? "missing", "Use the service-owned boundary.");
  const beforeAcceptance = await rootProjection(world);
  const staleDescription = renderRootDescription(
    beforeAcceptance.requirement,
    beforeAcceptance.state as NonNullable<typeof beforeAcceptance.state>,
    beforeAcceptance.reconcile_report,
    DESCRIPTION_TIMESTAMP,
  );
  makeStaleRootReadback(world, staleDescription);
  const acceptedCompletion = {
    ...complete("The selected boundary is already verified."),
    reply_disposition: "accepted",
    architecture_decisions: [{
      title: "Use service ownership",
      decision: "Use the service-owned transaction boundary.",
      rationale: "The human selected service ownership.",
      consequences: ["The service coordinates the transaction."],
    }] as never,
  } as RootReconcileDecision;
  const conductor = new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([acceptedCompletion], []),
    cycleRunner: {} as CycleRunner, workspace: world.workspace, maxCycles: 1,
  });

  await assert.rejects(conductor.run("ENG-1"), /accepted_architecture_decision_readback_mismatch/u);
  assert.deepEqual(world.gateway.reactions.map(({ reply_id, emoji }) => ({ reply_id, emoji })), [
    { reply_id: reply.id, emoji: "white_check_mark" },
  ]);
  const projection = await rootProjection(world);
  assert.equal(projection.state?.human_action?.comment_id, action?.id);
  assert.deepEqual(projection.state?.architecture_decisions, []);
  assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "needs-human-id");
});

test("does not start a Cycle when an accepted Architecture Decision read-back is stale", async () => {
  const world = await scenario();
  const workflow = { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" };
  await new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([needsHuman("Choose an API boundary")], []),
    cycleRunner: {} as CycleRunner, workspace: world.workspace, maxCycles: 1,
  }).run("ENG-1");
  const action = (await world.gateway.list_root_comments_after("root-id"))[0];
  assert.notEqual(action, undefined);
  const reply = await world.gateway.create_comment_reply("root-id", action?.id ?? "missing", "Use the service-owned boundary.");
  const beforeAcceptance = await rootProjection(world);
  const state = beforeAcceptance.state;
  if (state === undefined) throw new Error("missing_root_state");
  const staleDescription = renderRootDescription(
    beforeAcceptance.requirement,
    parseRootState({
      ...state,
      architecture_decisions: [{
        id: "ADR-001",
        title: "An older boundary decision",
        decision: "Use the caller-owned transaction boundary.",
        rationale: "This decision predates the current reply.",
        consequences: ["The caller coordinates the transaction."],
        source_action_comment_id: action?.id,
        source_reply_ids: [reply.id],
        decided_at: "2026-08-05 00:00:00 GMT+08:00",
      }],
    }),
    beforeAcceptance.reconcile_report,
    DESCRIPTION_TIMESTAMP,
  );
  makeStaleRootReadback(world, staleDescription);
  const acceptedCycle = {
    ...cycle("Apply the selected boundary"),
    reply_disposition: "accepted",
    architecture_decisions: [{
      title: "Use service ownership",
      decision: "Use the service-owned transaction boundary.",
      rationale: "The human selected service ownership.",
      consequences: ["The service coordinates the transaction."],
    }] as never,
  } as RootReconcileDecision;
  let cycleRuns = 0;
  const conductor = new Conductor({
    gateway: world.gateway, workflow,
    reconciler: scriptedReconciler([acceptedCycle], []),
    cycleRunner: { run: async () => { cycleRuns += 1; } } as unknown as CycleRunner,
    workspace: world.workspace, maxCycles: 1,
  });

  await assert.rejects(conductor.run("ENG-1"), /accepted_architecture_decision_readback_mismatch/u);
  assert.equal(cycleRuns, 0);
  assert.deepEqual(world.gateway.reactions.map(({ reply_id, emoji }) => ({ reply_id, emoji })), [
    { reply_id: reply.id, emoji: "white_check_mark" },
  ]);
  assert.equal((await rootProjection(world)).state?.human_action?.comment_id, action?.id);
  assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "review-id");
});

test("a recorded delivery completes Root without resolving the workspace", async () => {
  const world = await scenario();
  await setRootState(world, parseRootState({
    workspace_path: world.workspacePath,
    run_directory: world.runDirectory,
    root_branch: "root/ENG-1",
    current_phase: "completed",
    task_state_markdown: "All acceptance checks passed",
    architecture_decisions: [],
    delivery: { kind: "pull_request", url: "https://github.com/acme/repo/pull/9", branch: "root/ENG-1" },
  }));
  let workspaceResolutions = 0;
  const conductor = new Conductor({
    gateway: world.gateway, workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: { reconcile: async () => { throw new Error("unexpected_reconcile"); } },
    cycleRunner: {} as CycleRunner,
    workspace: async () => {
      workspaceResolutions += 1;
      throw new Error("workspace_must_not_be_resolved");
    }, maxCycles: 1,
  });
  assert.deepEqual(await conductor.run("ENG-1"), {
    status: "done", delivery: { kind: "pull_request", url: "https://github.com/acme/repo/pull/9", branch: "root/ENG-1" },
  });
  assert.equal(workspaceResolutions, 0);
  assert.equal((await world.gateway.get_issue("ENG-1")).status, "completed");
});

test("completion consumes ordinary Root input supplied to that Reconcile", async () => {
  const world = await scenario();
  const comment = await world.gateway.create_comment("root-id", "New requirement");
  const requests: RootReconcileRequest[] = [];
  const conductor = new Conductor({
    gateway: world.gateway, workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: scriptedReconciler([complete("Already done")], requests),
    cycleRunner: {} as CycleRunner,
    workspace: world.workspace, maxCycles: 1,
  });
  assert.deepEqual(await conductor.run("ENG-1"), {
    status: "done", delivery: { kind: "branch", branch: "root/ENG-1" },
  });
  assert.equal(requests[0]?.new_root_comments[0]?.id, comment.id);
  assert.equal((await rootProjection(world)).state?.comment_cursor, comment.id);
});

test("a recorded branch delivery completes Root", async () => {
  const world = await scenario();
  await setRootState(world, parseRootState({
    workspace_path: world.workspacePath,
    run_directory: world.runDirectory,
    root_branch: "root/ENG-1",
    current_phase: "completed",
    task_state_markdown: "All acceptance checks passed",
    architecture_decisions: [],
    delivery: { kind: "branch", branch: "root/ENG-1" },
  }));
  const conductor = new Conductor({
    gateway: world.gateway,
    workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: { reconcile: async () => { throw new Error("unexpected_reconcile"); } },
    cycleRunner: {} as CycleRunner,
    workspace: async () => { throw new Error("workspace_must_not_be_resolved"); },
    maxCycles: 1,
  });

  assert.deepEqual(await conductor.run("ENG-1"), { status: "done", delivery: { kind: "branch", branch: "root/ENG-1" } });
  assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "completed-id");
});

test("an escaped Cycle failure records the current message and moves Root to In Review", async () => {
  const world = await scenario();
  const error = new Error("native cycle failure detail that exceeds the visible fifty character boundary");
  const conductor = new Conductor({
    gateway: world.gateway,
    workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: scriptedReconciler([cycle("Trigger one runtime failure")], []),
    cycleRunner: { run: async () => { throw error; } } as unknown as CycleRunner,
    workspace: world.workspace,
    maxCycles: 1,
  });

  await assert.rejects(conductor.run("ENG-1"), (caught: unknown) => caught === error);
  assert.equal((await world.gateway.get_issue("ENG-1")).status_id, "review-id");
  const state = (await rootProjection(world)).state;
  assert.notEqual(state, undefined);
  if (state === undefined) throw new Error("missing_root_state");
  assert.equal(state.current_phase, "failed");
  assert.equal(state.harness_feedback, error.message.slice(0, 50));
});

test("comments every Reconcile decision with semantic whole-worktree changes and short total tokens", async () => {
  const world = await scenario();
  await exec("git", ["init"], { cwd: world.workspacePath });
  await Promise.all([
    writeFile(path.join(world.workspacePath, "updated.txt"), "before\n", "utf8"),
    writeFile(path.join(world.workspacePath, "deleted.txt"), "gone\n", "utf8"),
  ]);
  await exec("git", ["add", "."], { cwd: world.workspacePath });
  await exec("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "baseline",
  ], { cwd: world.workspacePath });

  let reconcile = 0;
  const reconciler = {
    async reconcile() {
      reconcile += 1;
      return reconcile === 1
        ? {
            decision: cycle("Apply the complete file change set"),
            process: {
              launch_status: "exited" as const, exit_code: 0, duration_ms: 1,
              token_usage: { input_tokens: 300, output_tokens: 100, total_tokens: 400 },
            },
          }
        : {
            decision: complete("The audited worktree satisfies the Root requirement."),
            process: {
              launch_status: "exited" as const, exit_code: 0, duration_ms: 1,
              token_usage: { input_tokens: 450, output_tokens: 150, total_tokens: 600 },
            },
          };
    },
  };
  const performer: Performer = {
    async launch(request) {
      if (request.final_response_path === undefined) throw new Error("missing_final_response_path");
      if (request.sandbox === "workspace_write") {
        await Promise.all([
          writeFile(path.join(world.workspacePath, "created.txt"), "one\ntwo\n", "utf8"),
          writeFile(path.join(world.workspacePath, "updated.txt"), "after\nnew\n", "utf8"),
          rm(path.join(world.workspacePath, "deleted.txt")),
          writeFile(request.final_response_path, "## Summary\nChanged three files.\n", "utf8"),
        ]);
        return {
          launch_status: "exited", exit_code: 0, duration_ms: 1,
          final_response_ref: request.final_response_path,
          diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
          diagnostic_stderr_ref: request.diagnostic_stderr_path,
          token_usage: { input_tokens: 75, output_tokens: 25, total_tokens: 100 },
        };
      }
      await writeFile(request.final_response_path, [
        "```json", JSON.stringify({ verdict: "accepted", task_state_markdown: "The file change set is verified." }), "```", "",
        "## Critic Audit", "The three intended file operations are correct.", "",
        "## Checks", "- git diff", "", "## Evidence", "- Created, updated, and deleted paths inspected.", "",
      ].join("\n"), "utf8");
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 1,
        final_response_ref: request.final_response_path,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
        token_usage: { input_tokens: 150, output_tokens: 50, total_tokens: 200 },
      };
    },
  };
  const cycleRunner = new CycleRunner({
    gateway: world.gateway, artistPerformer: performer, criticPerformer: performer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const conductor = new Conductor({
    gateway: world.gateway,
    workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler, cycleRunner,
    workspace: world.workspace, maxCycles: 2,
  });

  assert.equal((await conductor.run("ENG-1")).status, "done");
  const projection = await rootProjection(world);
  const completed = projection.reconcile_report ?? "";
  assert.match(completed, /#### Created\n- created\.txt: \+2 lines/u);
  assert.match(completed, /#### Updated\n- updated\.txt: \+2 \/ -1 lines/u);
  assert.match(completed, /#### Deleted\n- deleted\.txt: -1 lines/u);
  assert.match(completed, /### Line Changes\n\+4 \/ -2 lines/u);
  assert.match(completed, /### Run Metrics\nDuration: [0-9]+(?:ms|s|m [0-9]+s)\nTotal tokens: 1\.3k/u);
  assert.doesNotMatch(completed, /(?:^|\n)(?:\?\?|[ MADRCU?!]{1,2}) /u);
  assert.equal(projection.state?.token_usage?.total_tokens, 1_300);
});

test("bounds untracked file reads while collecting the Reconcile worktree summary", async () => {
  const world = await scenario();
  await exec("git", ["init"], { cwd: world.workspacePath });
  await writeFile(path.join(world.workspacePath, "tracked.txt"), "baseline\n", "utf8");
  await exec("git", ["add", "tracked.txt"], { cwd: world.workspacePath });
  await exec("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "baseline",
  ], { cwd: world.workspacePath });
  await writeFile(path.join(world.workspacePath, "oversized.txt"), Buffer.alloc(2 * 1024 * 1024 + 1));
  const requests: RootReconcileRequest[] = [];
  const conductor = new Conductor({
    gateway: world.gateway,
    workflow: { team_id: "team-id", todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", needs_human_status_id: "needs-human-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    reconciler: scriptedReconciler([complete("The bounded summary behavior is verified.")], requests),
    cycleRunner: { run: async () => { throw new Error("cycle_must_not_run"); } } as unknown as CycleRunner,
    workspace: world.workspace,
    maxCycles: 1,
  });

  assert.equal((await conductor.run("ENG-1")).status, "done");
  assert.equal(requests[0]?.worktree_summary.status, "unavailable");
  assert.match(requests[0]?.worktree_summary.reason ?? "", /worktree_file_too_large/u);
});
