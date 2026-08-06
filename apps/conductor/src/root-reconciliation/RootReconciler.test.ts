import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Performer } from "../performer/api/Performer.js";
import type { PerformerLaunchRequest } from "../contracts/performer.js";
import { parseRootReconcileRequest } from "../contracts/root.js";
import { RootReconciler } from "./RootReconciler.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-reconcile-"));
  const workspace = path.join(directory, "workspace-secret-path");
  const runDirectory = path.join(directory, "run-secret-path");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
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
      pending_finding: "Parser accepts an ambiguous token.", comment_cursor: "comment-0",
    },
    new_root_comments: [
      { id: "comment-1", issue_id: "root-id", body: "Preserve error locations.", creator_id: "user-id", created_at: "2026-08-05T01:00:00Z" },
      { id: "comment-2", issue_id: "root-id", body: "Do not add recovery.", creator_id: "user-id", created_at: "2026-08-05T01:01:00Z" },
    ],
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

function createReconciler(performer: Performer, runDirectory: string) {
  return new RootReconciler({
    performer, runDirectory, reconcileAgent: "codex", reconcileModel: "gpt-5.6-luna",
    reconcileReasoningEffort: "max", timeoutMs: 1_000,
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
  "### Question", "Which caller owns it?", "",
  "### Next Step", "Wait for an explicit Root comment.",
].join("\n");

test("Prepare delegates the exact preferred worktree binding to Root Reconcile", async () => {
  const world = await fixture();
  const preferred = path.join(path.dirname(world.workspace), "preferred-root");
  const launches: PerformerLaunchRequest[] = [];
  const reconciler = createReconciler(performerWith([
    "decision: prepared", "", "## Workspace",
    JSON.stringify({ workspace_path: preferred, run_directory: world.runDirectory, root_branch: "root/ENG-1" }),
    "", "## Report", "### Summary", "Created the preferred Root worktree.", "", "### Evidence", "The branch is attached.",
  ].join("\n"), launches), world.runDirectory);

  const workspace = await reconciler.prepare(world.request.root, preferred);
  assert.deepEqual(workspace, { workspace_path: preferred, run_directory: world.runDirectory, root_branch: "root/ENG-1" });
  assert.equal(launches[0]?.sandbox, "danger_full_access");
  assert.equal(launches[0]?.working_directory, process.cwd());
  assert.deepEqual(launches[0]?.additional_writable_directories, [path.dirname(preferred)]);
  assert.match(launches[0]?.prompt ?? "", /Prepare phase/u);
  assert.equal(launches[0]?.prompt.includes(preferred), true);
});

test("Prepare without a preferred path lets Root Reconcile create a sibling worktree", async () => {
  const world = await fixture();
  const prepared = path.join(path.dirname(process.cwd()), "symphony-root-eng-1");
  const launches: PerformerLaunchRequest[] = [];
  const reconciler = createReconciler(performerWith([
    "decision: prepared", "", "## Workspace",
    JSON.stringify({ workspace_path: prepared, run_directory: world.runDirectory, root_branch: "root/ENG-1" }),
    "", "## Report", "### Summary", "Created a dedicated Root worktree.", "", "### Evidence", "The Root branch is attached.",
  ].join("\n"), launches), world.runDirectory);

  assert.deepEqual(await reconciler.prepare(world.request.root), {
    workspace_path: prepared, run_directory: world.runDirectory, root_branch: "root/ENG-1",
  });
  assert.deepEqual(launches[0]?.additional_writable_directories, [path.dirname(process.cwd())]);
  assert.match(launches[0]?.prompt ?? "", /First try to create a dedicated Root worktree/u);
  assert.match(launches[0]?.prompt ?? "", /Only if worktree creation is unavailable/u);
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
  assert.equal(launches[0]?.prompt.includes("decision: cycle\n\n## Objective"), true);
  assert.equal(launches[0]?.prompt.includes("decision: complete\n\n## Summary"), true);
  assert.equal(launches[0]?.prompt.includes("decision: needs_human\n\n## Reason"), true);
});

test("includes the complete latest Critic in the prompt without child DAG content", async () => {
  const audits = [
    {
      verdict: "accepted",
      scope_reviewed: "Parser behavior and focused tests.",
      implementation_review: "Parser behavior is verified.",
      checks: ["npm test"],
      evidence: ["Focused test passed."],
      findings: [],
      task_state_markdown: "Parser behavior is trusted.",
    },
    { verdict: "process_error", reason: "critic_start_failed" },
  ] as const;

  for (const latest_critique of audits) {
    const world = await fixture();
    const request = parseRootReconcileRequest({
      phase: "reconcile",
      root: world.request.root,
      root_state: { ...world.request.root_state, latest_critique },
      new_root_comments: world.request.new_root_comments,
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
    `decision: needs_human\n\n## Reason\nThe requested API boundary is ambiguous.\n\n## Question\nWhich caller owns it?\n\n## Report\n${humanReport}\n`,
    humanLaunches,
  ), world.runDirectory);
  assert.deepEqual((await human.reconcile(world.request)).decision, {
    kind: "needs_human", reason: "The requested API boundary is ambiguous.", question: "Which caller owns it?", report: humanReport,
  });
  assert.equal(humanLaunches.length, 1);
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

test("publishes the current process message without a phase prefix or cause traversal", async () => {
  const world = await fixture();
  const directMessage = "root process detail that is intentionally longer than fifty characters";
  const failed = createReconciler({
    launch: async () => ({
      launch_status: "start_failed",
      duration_ms: 1,
      sanitized_reason: directMessage,
    }),
  }, world.runDirectory);
  const failedOutcome = await failed.reconcile(world.request);
  assert.equal(failedOutcome.decision.kind, "needs_human");
  assert.equal(failedOutcome.decision.kind === "needs_human" && failedOutcome.decision.reason, directMessage.slice(0, 50));
  assert.equal(failedOutcome.process?.launch_status, "start_failed");

  const thrownMessage = "native reconciliation failure that is longer than fifty characters";
  const thrown = createReconciler({
    launch: async () => {
      throw new Error(thrownMessage, { cause: new Error("provider cause must remain private") });
    },
  }, world.runDirectory);
  const thrownDecision = (await thrown.reconcile(world.request)).decision;
  assert.equal(thrownDecision.kind, "needs_human");
  assert.equal(thrownDecision.kind === "needs_human" && thrownDecision.reason, thrownMessage.slice(0, 50));
  assert.equal(thrownDecision.kind === "needs_human" && thrownDecision.reason.includes("provider cause"), false);

  const malformed = createReconciler(performerWith("I think we should continue.", []), world.runDirectory);
  const malformedDecision = (await malformed.reconcile(world.request)).decision;
  assert.equal(malformedDecision.kind, "needs_human");
  assert.equal(malformedDecision.kind === "needs_human" && malformedDecision.reason, "invalid_root_reconcile_response");

  const missingDiagnostics = createReconciler({
    launch: async (request) => {
      await writeFile(request.final_response_path as string, "decision: complete\n\n## Summary\nDone.\n", "utf8");
      return { launch_status: "exited", exit_code: 0, duration_ms: 1, final_response_ref: request.final_response_path };
    },
  }, world.runDirectory);
  const missingDecision = (await missingDiagnostics.reconcile(world.request)).decision;
  assert.equal(missingDecision.kind, "needs_human");
  assert.equal(missingDecision.kind === "needs_human" && missingDecision.reason, "Diagnostic capture failed");
});
