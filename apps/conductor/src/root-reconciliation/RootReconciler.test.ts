import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { Performer } from "../performer/api/Performer.js";
import type { PerformerLaunchRequest } from "../contracts/performer.js";
import { parseRootReconcileRequest } from "../contracts/root.js";
import { RootReconciler } from "./RootReconciler.js";

const execute = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-reconcile-"));
  const workspace = path.join(directory, "workspace-secret-path");
  const runDirectory = path.join(directory, "run-secret-path");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
  await execute("git", ["-C", workspace, "init", "-b", "main"]);
  const request = parseRootReconcileRequest({
    phase: "reconcile",
    root: {
      id: "root-id", identifier: "ENG-1", title: "Implement the parser",
      description: "The parser must reject ambiguous input.", url: "https://linear.app/acme/issue/ENG-1",
      status: "active", status_id: "state-in-progress",
      parent_id: null, team_id: "team-id", creator_id: "user-id",
    },
    root_state: {
      workspace_path: workspace, run_directory: runDirectory, root_branch: "root/ENG-1",
      current_phase: "idle", task_state_markdown: "The lexer is complete.",
      latest_critique: {
        verdict: "incomplete", task_state_markdown: "The lexer is complete.",
        pending_finding: "Parser accepts an ambiguous token.",
        artifact_url: "https://linear.invalid/upload/critique.json",
      },
      comment_cursor: "comment-0",
      architecture_decisions: [],
    },
    new_root_comments: [
      { id: "comment-1", issue_id: "root-id", parent_id: null, body: "Preserve error locations.", creator_id: "user-id", created_at: "2026-08-05T01:00:00Z" },
      { id: "comment-2", issue_id: "root-id", parent_id: null, body: "Do not add recovery.", creator_id: "user-id", created_at: "2026-08-05T01:01:00Z" },
    ],
    human_action_replies: [],
    worktree_summary: {
      status: "available", created: [], updated: [], deleted: [], insertions: 0, deletions: 0,
    },
  });
  return { request, runDirectory, workspace };
}

function performerWith(response: string, requests: PerformerLaunchRequest[]): Performer {
  return {
    async launch(request) {
      requests.push(request);
      const responsePath = request.final_response_path;
      assert.notEqual(responsePath, undefined);
      await writeFile(responsePath as string, response, "utf8");
      return {
        launch_status: "exited",
        exit_code: 0,
        duration_ms: 5,
        final_response_ref: responsePath as string,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
}

function createReconciler(performer: Performer, runDirectory: string, invocationCwd?: string) {
  return new RootReconciler({
    performer, runDirectory, reconcileAgent: "codex", reconcileModel: "gpt-5.6-luna",
    reconcileReasoningEffort: "max", timeoutMs: 1_000,
    ...(invocationCwd === undefined ? {} : { invocationCwd }),
  });
}

const cycleReport = [
  "### Why Continue", "The latest trusted state still contains an open parser finding.", "",
  "### Evidence", "The pending finding says ambiguous input is accepted.", "",
  "### Next Cycle", "Reject ambiguous parser input and verify the failure case.",
].join("\n");

const completeReport = [
  "### Overview", "All trusted acceptance checks are satisfied.", "",
  "### File Changes", "#### Created", "- None", "", "#### Updated", "- None", "", "#### Deleted", "- None", "",
  "### Line Changes", "+0 / -0 lines", "",
  "### Verification", "The latest Critic accepted the complete workspace.", "",
  "### Run Metrics", "Duration: 0ms", "Total tokens: Unknown",
].join("\n");

const humanReport = [
  "### Reason", "The requested API boundary is ambiguous.", "",
  "### Question", "Choose one caller boundary.", "",
  "### Next Step", "Wait for an explicit Root comment.",
].join("\n");

const humanQuestions = JSON.stringify([
  {
    question: "Which caller owns the boundary?",
    options: [
      { key: "root", label: "Root owns it", consequence: "Keep the decision in Root Reconcile." },
      { key: "cycle", label: "Cycle owns it", consequence: "Create a bounded Cycle for the decision." },
    ],
  },
]);

test("Prepare adopts the exact preferred Git root without launching an Agent", async () => {
  const world = await fixture();
  const launches: PerformerLaunchRequest[] = [];
  const reconciler = createReconciler(performerWith("unused", launches), world.runDirectory, world.workspace);

  assert.deepEqual(await reconciler.prepare(world.request.root, world.workspace), {
    workspace_path: await realpath(world.workspace),
    run_directory: await realpath(world.runDirectory),
    root_branch: "main",
  });
  assert.deepEqual(launches, []);
});

test("Prepare without a preferred path adopts the invocation checkout without launching an Agent", async () => {
  const world = await fixture();
  const launches: PerformerLaunchRequest[] = [];
  const reconciler = createReconciler(performerWith("unused", launches), world.runDirectory, world.workspace);

  assert.deepEqual(await reconciler.prepare(world.request.root), {
    workspace_path: await realpath(world.workspace),
    run_directory: await realpath(world.runDirectory),
    root_branch: "main",
  });
  assert.deepEqual(launches, []);
});

test("returns one Cycle draft from Root-owned inputs without exposing workspace paths", async () => {
  const world = await fixture();
  const launches: PerformerLaunchRequest[] = [];
  const reconciler = createReconciler(performerWith([
    "decision: cycle", "", "## Objective", "Reject ambiguous parser input.", "",
    "## Acceptance", "A read-only test proves ambiguous input is rejected.", "",
    "## Boundaries", "Only parser validation and its tests are in scope.", "",
    "## Report", cycleReport,
  ].join("\n"), launches), world.runDirectory);

  assert.deepEqual((await reconciler.reconcile(world.request)).decision, {
    kind: "create_cycle", cycle: {
      objective: "Reject ambiguous parser input.",
      acceptance: "A read-only test proves ambiguous input is rejected.",
      boundaries: "Only parser validation and its tests are in scope.",
    },
    report: cycleReport,
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.sandbox, "danger_full_access");
  assert.equal(launches[0]?.working_directory, world.workspace);
  assert.equal(launches[0]?.diagnostic_jsonl_path?.startsWith(world.runDirectory), true);
  assert.equal(launches[0]?.diagnostic_stderr_path?.startsWith(world.runDirectory), true);
  assert.equal(launches[0]?.prompt.includes(world.workspace), true);
  assert.equal(launches[0]?.prompt.includes(world.runDirectory), false);
  assert.equal(launches[0]?.prompt.includes("Preserve error locations."), true);
  assert.equal(launches[0]?.prompt.includes("Do not add recovery."), true);
  assert.equal(launches[0]?.prompt.includes("## Latest Critic Result"), false);
  assert.equal(launches[0]?.prompt.includes("decision: cycle\n\n## Reply Disposition\n"), true);
  assert.equal(launches[0]?.prompt.includes("decision: complete\n\n## Reply Disposition\n"), true);
  assert.equal(launches[0]?.prompt.includes("decision: needs_human\n\n## Reply Disposition\n"), true);
});

test("includes only the compact latest Critic checkpoint without child DAG content", async () => {
  const audits = [
    {
      verdict: "accepted",
      task_state_markdown: "Parser behavior is trusted.",
      pending_finding: "Keep the parser boundary explicit.",
      artifact_url: "https://linear.invalid/upload/critique-accepted.json",
    },
    {
      verdict: "process_error",
      reason: "critic_start_failed",
      artifact_url: "https://linear.invalid/upload/critique-error.json",
    },
  ] as const;

  for (const latest_critique of audits) {
    const world = await fixture();
    const request = parseRootReconcileRequest({
      phase: "reconcile",
      root: world.request.root,
      root_state: { ...world.request.root_state, latest_critique },
      new_root_comments: world.request.new_root_comments,
      human_action_replies: world.request.human_action_replies,
      worktree_summary: world.request.worktree_summary,
    });
    const launches: PerformerLaunchRequest[] = [];
    const reconciler = createReconciler(performerWith(
      `decision: complete\n\n## Summary\nTrusted state is complete.\n\n## Delivery\n{"kind":"files","workspace_path":"${world.workspace}","files":["result.txt"]}\n\n## Report\n${completeReport}\n`,
      launches,
    ), world.runDirectory);

    await reconciler.reconcile(request);
    const prompt = launches[0]?.prompt ?? "";
    assert.equal(prompt.includes(`<<< BEGIN LATEST_CRITIC >>>\n${JSON.stringify(latest_critique, null, 2)}`), true);
    assert.equal(prompt.includes("scope_reviewed"), false);
    assert.equal(prompt.includes("implementation_review"), false);
    assert.equal(prompt.includes('"checks"'), false);
    assert.equal(prompt.includes('"evidence"'), false);
    assert.equal(prompt.includes('"findings"'), false);
    assert.equal(prompt.includes("Cycle DAG"), false);
    assert.equal(prompt.includes("## Artist"), false);
    assert.equal(prompt.includes("cycle-child-secret"), false);
    assert.equal(prompt.includes("execute-child-secret"), false);
  }
});

test("parses completion and human decisions without a repair turn", async () => {
  const world = await fixture();
  const completeLaunches: PerformerLaunchRequest[] = [];
  const complete = createReconciler(performerWith(
    `decision: complete\n\n## Summary\nAll trusted acceptance checks are satisfied.\n\n## Delivery\n{"kind":"files","workspace_path":"${world.workspace}","files":["result.txt"]}\n\n## Report\n${completeReport}\n`,
    completeLaunches,
  ), world.runDirectory);
  assert.deepEqual((await complete.reconcile(world.request)).decision, {
    kind: "complete", summary: "All trusted acceptance checks are satisfied.", report: completeReport,
    delivery: { kind: "files", workspace_path: world.workspace, files: ["result.txt"] },
  });
  assert.equal(completeLaunches.length, 1);

  const humanLaunches: PerformerLaunchRequest[] = [];
  const human = createReconciler(performerWith(
    `decision: needs_human\n\n## Reason\nThe requested API boundary is ambiguous.\n\n## Questions\n\`\`\`json\n${humanQuestions}\n\`\`\`\n\n## Report\n${humanReport}\n`,
    humanLaunches,
  ), world.runDirectory);
  assert.deepEqual((await human.reconcile(world.request)).decision, {
    kind: "needs_human", reason: "The requested API boundary is ambiguous.",
    questions: [{
      question: "Which caller owns the boundary?",
      options: [
        { key: "root", label: "Root owns it", consequence: "Keep the decision in Root Reconcile." },
        { key: "cycle", label: "Cycle owns it", consequence: "Create a bounded Cycle for the decision." },
      ],
    }],
    report: humanReport,
  });
  assert.equal(humanLaunches.length, 1);

  const unknownSection = createReconciler(performerWith(
    `decision: needs_human\n\n## Reason\nThe boundary is ambiguous.\n\n## Questions\n\`\`\`json\n${humanQuestions}\n\`\`\`\n\n## Bogus\nIgnored content.\n\n## Report\n${humanReport}\n`,
    [],
  ), world.runDirectory);
  await assert.rejects(unknownSection.reconcile(world.request), /invalid_root_reconcile_response/u);
});

test("requires and classifies the whole reply batch", async () => {
  const world = await fixture();
  const resumedRequest = parseRootReconcileRequest({
    ...world.request,
    root_state: {
      ...world.request.root_state,
      current_phase: "NeedsHuman",
      human_action: { comment_id: "human-action-1" },
    },
    human_action_replies: [{
      id: "human-reply-1", issue_id: "root-id", parent_id: "human-action-1",
      body: "Choose strict parsing.", creator_id: "user-id", created_at: "2026-08-05T02:00:00Z",
    }],
  });
  const acceptedLaunches: PerformerLaunchRequest[] = [];
  const accepted = createReconciler(performerWith(
    `decision: complete\n\n## Reply Disposition\naccepted\n\n## Architecture Decisions\n\`\`\`json\n[{"title":"Preserve strict parsing","decision":"Reject ambiguous tokens.","rationale":"The human selected strict parsing.","consequences":["Recovery remains out of scope."]}]\n\`\`\`\n\n## Summary\nTrusted state is complete.\n\n## Delivery\n{"kind":"files","workspace_path":"${world.workspace}","files":["result.txt"]}\n\n## Report\n${completeReport}\n`,
    acceptedLaunches,
  ), world.runDirectory);
  assert.equal((await accepted.reconcile(resumedRequest)).decision.kind, "complete");

  const rejectedLaunches: PerformerLaunchRequest[] = [];
  const rejected = createReconciler(performerWith(
    `decision: needs_human\n\n## Reply Disposition\nrejected\n\n## Reason\nThe reply batch conflicts.\n\n## Questions\n\`\`\`json\n${humanQuestions}\n\`\`\`\n\n## Report\n${humanReport}\n`,
    rejectedLaunches,
  ), world.runDirectory);
  const rejectedDecision = (await rejected.reconcile(resumedRequest)).decision;
  assert.equal(rejectedDecision.kind, "needs_human");
  assert.equal(rejectedDecision.kind === "needs_human" && rejectedDecision.reply_disposition, "rejected");

  const missingDisposition = createReconciler(performerWith(
    `decision: complete\n\n## Summary\nTrusted state is complete.\n\n## Delivery\n{"kind":"files","workspace_path":"${world.workspace}","files":["result.txt"]}\n\n## Report\n${completeReport}\n`,
    [],
  ), world.runDirectory);
  await assert.rejects(missingDisposition.reconcile(resumedRequest), /invalid_reply_disposition/u);
});

test("omits model and reasoning so Root Reconcile can use local Codex defaults", async () => {
  const world = await fixture();
  const launches: PerformerLaunchRequest[] = [];
  const reconciler = new RootReconciler({
    performer: performerWith(
      `decision: complete\n\n## Summary\nTrusted state is complete.\n\n## Delivery\n{"kind":"files","workspace_path":"${world.workspace}","files":["result.txt"]}\n\n## Report\n${completeReport}\n`,
      launches,
    ),
    runDirectory: world.runDirectory,
    reconcileAgent: "codex",
    timeoutMs: 1_000,
  });

  assert.equal((await reconciler.reconcile(world.request)).decision.kind, "complete");
  assert.equal(launches[0]?.model, undefined);
  assert.equal(launches[0]?.reasoning_effort, undefined);
});

test("throws the current process message without inventing a human question", async () => {
  const world = await fixture();
  const directMessage = "root process detail that is intentionally longer than fifty characters";
  const failed = createReconciler({
    launch: async () => ({
      launch_status: "start_failed",
      duration_ms: 1,
      sanitized_reason: directMessage,
    }),
  }, world.runDirectory);
  await assert.rejects(failed.reconcile(world.request), new RegExp(directMessage.slice(0, 50), "u"));

  const credentialShaped = createReconciler({
    launch: async () => ({
      launch_status: "start_failed", duration_ms: 1,
      sanitized_reason: "api_key=secret-value-that-must-not-escape",
    }),
  }, world.runDirectory);
  await assert.rejects(credentialShaped.reconcile(world.request), /Process failed/u);

  const thrownMessage = "native reconciliation failure that is longer than fifty characters";
  const thrown = createReconciler({
    launch: async () => {
      throw new Error(thrownMessage, { cause: new Error("provider cause must remain private") });
    },
  }, world.runDirectory);
  await assert.rejects(thrown.reconcile(world.request), new RegExp(thrownMessage.slice(0, 50), "u"));

  const malformed = createReconciler(performerWith("I think we should continue.", []), world.runDirectory);
  await assert.rejects(malformed.reconcile(world.request), /invalid_root_reconcile_response/u);

  const invalidUtf8 = createReconciler({
    async launch(request) {
      await writeFile(request.final_response_path as string, Buffer.from([0xff]));
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 1,
        final_response_ref: request.final_response_path,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  }, world.runDirectory);
  await assert.rejects(invalidUtf8.reconcile(world.request), /invalid_root_reconcile_response/u);

  const missingDiagnostics = createReconciler({
    launch: async (request) => {
      await writeFile(request.final_response_path as string, "decision: complete\n\n## Summary\nDone.\n", "utf8");
      return { launch_status: "exited", exit_code: 0, duration_ms: 1, final_response_ref: request.final_response_path };
    },
  }, world.runDirectory);
  await assert.rejects(missingDiagnostics.reconcile(world.request), /Diagnostic capture failed/u);
});
