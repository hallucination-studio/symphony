import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCycleSpec } from "../contracts/cycle.js";
import type { PerformerLaunchRequest, PerformerProcessResult } from "../contracts/performer.js";
import { parseRootState } from "../contracts/root.js";
import { parseLinearIssue } from "../contracts/task-management.js";
import { parseMarkdownText } from "../contracts/validation.js";
import { currentLinearDescriptionTimestamp } from "../linear/LinearDescriptionTimestamp.js";
import { parseManagedIssueDescription } from "../linear/LinearIssueDescription.js";
import { InMemoryLinearGateway } from "../linear/InMemoryLinearGateway.js";
import type { LinearGateway } from "../linear/LinearGateway.js";
import type { Performer } from "../performer/api/Performer.js";
import { CycleRunner } from "./CycleRunner.js";

const states = [
  { id: "todo-id", name: "Todo", type: "unstarted" as const, team_id: "team-id" },
  { id: "active-id", name: "Active", type: "started" as const, team_id: "team-id" },
  { id: "review-id", name: "In Review", type: "started" as const, team_id: "team-id" },
  { id: "completed-id", name: "Done", type: "completed" as const, team_id: "team-id" },
  { id: "canceled-id", name: "Canceled", type: "canceled" as const, team_id: "team-id" },
];

async function world() {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-cycle-"));
  const workspace = path.join(base, "workspace");
  const runDirectory = path.join(base, "run");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
  const gateway = new InMemoryLinearGateway({
    states,
    issues: [parseLinearIssue({
      id: "root-id", identifier: "ENG-1", title: "Root", description: "Build parser",
      url: "https://linear.invalid/ENG-1", status: "active", status_id: "active-id", parent_id: null,
      team_id: "team-id", creator_id: "user-id",
    })],
  });
  const spec = parseCycleSpec({
    cycle_number: 1, objective: "Reject ambiguity", acceptance: "Parser test passes",
    boundaries: "Parser only", consumed_comment_ids: ["comment-1"],
  });
  const rootState = parseRootState({
    workspace_path: workspace, run_directory: runDirectory, root_branch: "root/ENG-1",
    current_phase: "cycle", task_state_markdown: "Lexer complete", pending_finding: "Ambiguity remains",
  });
  const transitionComment = parseMarkdownText([
    "# Symphony Harness: Reconcile", "", "### Why Continue", "...", "", "### Evidence", "...", "",
    "### Next Cycle", "...",
  ].join("\n"));
  return { gateway, spec, rootState, workspace, runDirectory, transitionComment };
}

function performer(
  launches: PerformerLaunchRequest[],
  artistResult: PerformerProcessResult,
  criticResponse: unknown,
): Performer {
  return {
    async launch(request) {
      launches.push(request);
      if (request.sandbox === "workspace_write") {
        if (request.final_response_path !== undefined && artistResult.launch_status === "exited" && artistResult.exit_code === 0) {
          await writeFile(request.final_response_path, "Artist completed; this response is not Critic evidence.\n", "utf8");
          return { ...artistResult, final_response_ref: request.final_response_path };
        }
        return artistResult;
      }
      assert.equal(request.sandbox, "read_only");
      const responsePath = request.final_response_path;
      assert.notEqual(responsePath, undefined);
      await writeFile(responsePath as string, criticMarkdown(criticResponse), "utf8");
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 7,
        final_response_ref: responsePath as string,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
}

function criticMarkdown(value: unknown): string {
  if (typeof value === "string") return value;
  const result = value as Record<string, unknown>;
  if (result.verdict === "process_error") {
    return `verdict: process_error\n\n## Reason\n${String(result.reason)}\n`;
  }
  const list = (name: string) => {
    const entries = result[name] as readonly unknown[] | undefined;
    return (entries ?? []).length === 0 ? "- None" : (entries ?? []).map((entry) => `- ${String(entry)}`).join("\n");
  };
  return [
    `verdict: ${String(result.verdict)}`,
    "",
    "## Scope Reviewed", String(result.scope_reviewed ?? "The complete workspace diff."),
    "",
    "## Implementation Review", String(result.implementation_review ?? "The implementation was inspected."),
    "",
    "## Checks", list("checks"),
    "",
    "## Evidence", list("evidence"),
    "",
    "## Findings", list("findings"),
    "",
    "## Task State", String(result.task_state_markdown ?? result.implementation_review ?? "No independently audited task progress yet."),
    "",
  ].join("\n");
}

test("creates exact family and trusts only a fresh Critic", async () => {
  const fixture = await world();
  const launches: PerformerLaunchRequest[] = [];
  const rolePerformer = performer(launches, {
    launch_status: "exited", exit_code: 0, duration_ms: 4,
    diagnostic_jsonl_ref: "/external/diagnostics/artist.jsonl",
    diagnostic_stderr_ref: "/external/diagnostics/artist.stderr",
    thread_id: "thread-artist-must-stay-local",
  }, {
    verdict: "accepted", implementation_review: "Parser behavior is verified", checks: ["npm test"],
    evidence: ["test passes"], findings: [], task_state_markdown: "Parser ambiguity is rejected",
  });
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", artistModel: "artist-model", artistReasoningEffort: "high",
    criticAgent: "codex", criticModel: "critique-model", criticReasoningEffort: "xhigh", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.equal(outcome.terminal.result, "succeeded");
  assert.equal(outcome.critique.verdict, "accepted");
  assert.equal(launches.length, 2);
  assert.equal(launches[0]?.sandbox, "workspace_write");
  assert.equal(launches[0]?.agent, "codex");
  assert.equal(launches[0]?.model, "artist-model");
  assert.equal(launches[0]?.reasoning_effort, "high");
  assert.equal(launches[0]?.final_response_path, path.join(fixture.runDirectory, "cycle-001-artist-result.md"));
  assert.equal(launches[0]?.diagnostic_jsonl_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[0]?.diagnostic_stderr_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[1]?.sandbox, "read_only");
  assert.equal(launches[1]?.agent, "codex");
  assert.equal(launches[1]?.model, "critique-model");
  assert.equal(launches[1]?.reasoning_effort, "xhigh");
  assert.equal(launches[1]?.final_response_path, path.join(fixture.runDirectory, "cycle-001-critic-result.md"));
  assert.equal(launches[1]?.diagnostic_jsonl_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[1]?.diagnostic_stderr_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[1]?.prompt.includes("thread-artist-must-stay-local"), false);
  assert.equal(launches[1]?.prompt.includes("artist.jsonl"), false);
  assert.equal(launches[1]?.prompt.includes("Parser behavior is verified"), false);
  assert.match(launches[0]?.prompt ?? "", /final response.*Markdown/iu);
  assert.match(launches[0]?.prompt ?? "", /## Summary[\s\S]*## File Changes[\s\S]*## Verification/u);
  assert.match(launches[0]?.prompt ?? "", /Never copy raw porcelain markers such as `\?\?`, `M`, or `D`/u);
  assert.doesNotMatch(launches[0]?.prompt ?? "", /## Objective\n|## Acceptance\n|## Boundaries\n|## Trusted Task State\n/u);
  assert.match(launches[1]?.prompt ?? "", /first line is `verdict: ` followed by accepted, incomplete, blocked, violation, or process_error/u);
  assert.match(launches[1]?.prompt ?? "", /## Scope Reviewed[\s\S]*## Implementation Review[\s\S]*## Checks/u);
  assert.doesNotMatch(launches[1]?.prompt ?? "", /## Summary\n/u);
  const descendants = await fixture.gateway.list_unfinished_descendants("root-id");
  assert.deepEqual(descendants, []);
  const cycleRecord = JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001.json"), "utf8")) as Record<string, unknown>;
  assert.equal(cycleRecord.cycle_id, outcome.cycle.id);
  assert.equal(cycleRecord.artist_id, outcome.artist.id);
  assert.equal(cycleRecord.critic_id, outcome.criticIssue.id);
  assert.deepEqual(cycleRecord.consumed_comment_ids, ["comment-1"]);
  const persistedCritic = await readFile(path.join(fixture.runDirectory, "cycle-001-critique-result.json"));
  assert.deepEqual(JSON.parse(persistedCritic.toString("utf8")), outcome.critique);
  assert.deepEqual(fixture.gateway.attachments.map(({ filename, content_type, contents }) => ({
    filename, content_type, contents: Buffer.from(contents).toString("utf8"),
  })), [{
    filename: "cycle-001-critique-result.json",
    content_type: "application/json",
    contents: persistedCritic.toString("utf8"),
  }]);
});

test("projects the Cycle, Artist, and Critic lifecycle statuses visibly", async () => {
  const fixture = await world();
  const updates: Array<readonly [string, string]> = [];
  const creates: Array<{ readonly title: string; readonly status_id: string }> = [];
  const comments: Array<readonly [string, string]> = [];
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "create_issue") {
        return async (request: Parameters<LinearGateway["create_issue"]>[0]) => {
          creates.push({ title: request.title, status_id: request.status_id });
          return target.create_issue(request);
        };
      }
      if (property !== "update_issue_status") {
        if (property === "create_comment") {
          return async (issueId: string, body: string) => {
            comments.push([issueId, body]);
            return target.create_comment(issueId, body);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (issueId: string, statusId: string) => {
        updates.push([issueId, statusId]);
        await target.update_issue_status(issueId, statusId);
      };
    },
  });
  const rolePerformer = performer([], { launch_status: "exited", exit_code: 0, duration_ms: 1 }, {
    verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
    task_state_markdown: "Acceptance is verified",
  });
  const updatedAt = new Date("2026-08-05T01:02:03.000Z");
  const updatedAtText = currentLinearDescriptionTimestamp(updatedAt);
  let nowCalls = 0;
  const runner = new CycleRunner({
    gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
    now: () => {
      nowCalls += 1;
      return updatedAt;
    },
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => {
      assert.equal((await fixture.gateway.get_issue("fake-issue-1")).status_id, "active-id");
    },
  });

  assert.deepEqual(creates, [
    { title: "[Cycle 001] Reject ambiguity", status_id: "todo-id" },
    { title: "[Artist] Cycle 001", status_id: "todo-id" },
    { title: "[Critic] Cycle 001", status_id: "todo-id" },
  ]);
  assert.deepEqual(updates.map(([, statusId]) => statusId), [
    "active-id", "active-id", "completed-id", "review-id", "review-id", "completed-id", "completed-id",
  ]);
  assert.deepEqual(updates.map(([issueId]) => issueId), [
    "fake-issue-1", "fake-issue-2", "fake-issue-2", "fake-issue-1", "fake-issue-3", "fake-issue-3", "fake-issue-1",
  ]);
  const artistDescription = (await fixture.gateway.get_issue(outcome.artist.id)).description;
  const criticDescription = (await fixture.gateway.get_issue(outcome.criticIssue.id)).description;
  const cycleComments = comments.filter(([issueId]) => issueId === "fake-issue-1").map(([, body]) => body);
  assert.equal(cycleComments.length, 2);
  assert.equal(cycleComments[0], fixture.transitionComment);
  const cycleComment = cycleComments.find((body) => body.startsWith("## Cycle Result")) ?? "";
  const artistProjection = parseManagedIssueDescription(artistDescription);
  const criticProjection = parseManagedIssueDescription(criticDescription);
  assert.equal(artistProjection.metadata.includes("## Role\n\nArtist"), true);
  assert.equal(artistProjection.task.includes("## Objective\n\nReject ambiguity"), true);
  assert.equal(artistProjection.updated_at, updatedAtText);
  assert.equal(artistProjection.result, "Artist completed; this response is not Critic evidence.");
  assert.equal(criticProjection.metadata.includes("## Role\n\nCritic"), true);
  assert.equal(criticProjection.updated_at, updatedAtText);
  assert.equal(criticProjection.result?.startsWith("verdict: accepted"), true);
  assert.equal(criticProjection.result?.includes("## Scope Reviewed"), true);
  assert.equal(criticProjection.result?.includes("## Implementation Review"), true);
  assert.equal(nowCalls, 2);
  assert.equal(comments.some(([issueId]) => issueId === outcome.artist.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.criticIssue.id), false);
  assert.equal(cycleComment.includes("## Cycle Result"), true);
  assert.equal(cycleComment.includes(`- Result: ${outcome.terminal.result}`), true);
  assert.equal(cycleComment.includes(`- Critic Issue: ${outcome.criticIssue.id}`), true);
  assert.equal(cycleComment.includes(`- Critic verdict: ${outcome.critique.verdict}`), true);
  assert.equal(cycleComment.includes(`- Reason: ${outcome.terminal.reason}`), true);
  assert.equal(cycleComment.includes(criticDescription), false);
});

test("caps the Cycle title at 80 characters while naming role issues by Cycle", async () => {
  const fixture = await world();
  const longObjective = "Objective ".repeat(20);
  const spec = parseCycleSpec({
    ...fixture.spec,
    objective: longObjective,
  });
  const creates: string[] = [];
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "create_issue") {
        return async (request: Parameters<LinearGateway["create_issue"]>[0]) => {
          creates.push(request.title);
          return target.create_issue(request);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rolePerformer = performer([], { launch_status: "exited", exit_code: 0, duration_ms: 1 }, {
    verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
  });
  const runner = new CycleRunner({
    gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  await runner.run({
    rootId: "root-id", teamId: "team-id", spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.equal((creates[0] ?? "").length <= 80, true);
  assert.match(creates[0] ?? "", /^\[Cycle 001\] Objective /u);
  assert.equal(creates[1], "[Artist] Cycle 001");
  assert.equal(creates[2], "[Critic] Cycle 001");
});

test("rejects an Critic response too large to persist with Root State", async () => {
  const fixture = await world();
  const rolePerformer = performer([], {
    launch_status: "exited", exit_code: 0, duration_ms: 1,
  }, {
    verdict: "accepted",
    implementation_review: "x".repeat(33 * 1024),
    checks: [],
    evidence: [],
    findings: [],
  });
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.deepEqual(outcome.critique, { verdict: "process_error", reason: "Final response too large" });
  assert.equal(outcome.terminal.result, "failed");
});

test("audits residual workspace after Artist start failure", async () => {
  const fixture = await world();
  const launches: PerformerLaunchRequest[] = [];
  const rolePerformer = performer(launches, {
    launch_status: "start_failed", duration_ms: 1, sanitized_reason: "agent_unavailable",
  }, {
    verdict: "incomplete", implementation_review: "Required change is absent", checks: [], evidence: ["workspace unchanged"],
    findings: ["Parser still accepts ambiguity"], pending_finding: "Implement strict ambiguity rejection",
  });
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(launches.length, 2);
  assert.equal(launches[0]?.model, undefined);
  assert.equal(launches[0]?.reasoning_effort, undefined);
  assert.equal(launches[1]?.model, undefined);
  assert.equal(launches[1]?.reasoning_effort, undefined);
  assert.equal(outcome.terminal.result, "rejected");
  assert.equal(launches[1]?.prompt.includes("start_failed"), true);
  assert.equal(launches[1]?.prompt.includes("agent_unavailable"), true);
});

test("audits residual workspace when the Artist adapter rejects", async () => {
  const fixture = await world();
  const launches: PerformerLaunchRequest[] = [];
  const auditOnly = performer(launches, { launch_status: "exited", exit_code: 0, duration_ms: 1 }, {
    verdict: "accepted", implementation_review: "Residual workspace already satisfies acceptance", checks: [],
    evidence: ["workspace inspected"], findings: [], task_state_markdown: "Acceptance is verified",
  });
  let calls = 0;
  const rejectingPerformer: Performer = {
    launch: async (request, signal) => {
      calls += 1;
      if (calls === 1) throw new Error("private_adapter_failure");
      return auditOnly.launch(request, signal);
    },
  };
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: rejectingPerformer,
    criticPerformer: rejectingPerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.artistProcess.launch_status, "start_failed");
  assert.equal(outcome.artistProcess.sanitized_reason, "private_adapter_failure");
  assert.equal(outcome.terminal.result, "succeeded");
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.sandbox, "read_only");
});

test("fails the Cycle when Critic diagnostics are not durably referenced", async () => {
  const fixture = await world();
  const launches: PerformerLaunchRequest[] = [];
  const missingDiagnostics: Performer = {
    launch: async (request) => {
      launches.push(request);
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Artist completed.\n", "utf8");
        return {
          launch_status: "exited", exit_code: 0, duration_ms: 1,
          final_response_ref: request.final_response_path,
        };
      }
      await writeFile(request.final_response_path as string, criticMarkdown({
        verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
      }), "utf8");
      return { launch_status: "exited", exit_code: 0, duration_ms: 1, final_response_ref: request.final_response_path };
    },
  };
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: missingDiagnostics,
    criticPerformer: missingDiagnostics,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.equal(launches.length, 2);
  assert.equal(outcome.critique.verdict, "process_error");
  assert.equal(outcome.critique.reason, "diagnostic_capture_failed");
  assert.equal(outcome.terminal.result, "failed");
});

test("bounds the mechanical Cycle reason without changing the Critic verdict", async () => {
  const fixture = await world();
  const rolePerformer = performer([], { launch_status: "exited", exit_code: 0, duration_ms: 1 }, {
    verdict: "accepted", implementation_review: "x".repeat(2_000), checks: [], evidence: [], findings: [],
    task_state_markdown: "Acceptance is verified",
  });
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.critique.verdict, "accepted");
  assert.equal(outcome.terminal.result, "succeeded");
  assert.equal(outcome.terminal.reason.length <= 512, true);
  assert.match(outcome.terminal.reason, /\[truncated\]$/u);
});

test("writes explicit bounded role results with the current error message", async () => {
  const fixture = await world();
  const comments: Array<readonly [string, string]> = [];
  let calls = 0;
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "create_comment") {
        return async (issueId: string, body: string) => {
          comments.push([issueId, body]);
          return target.create_comment(issueId, body);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const executeError = new Error(
    "artist-current-message-that-is-longer-than-fifty-characters-and-must-be-bounded",
    { cause: new Error("private-cause-must-not-be-visible") },
  );
  const criticError = new Error(
    "critique-current-message-that-is-longer-than-fifty-characters-and-must-be-bounded",
    { cause: new Error("private-critique-cause-must-not-be-visible") },
  );
  const performerWithErrors: Performer = {
    async launch() {
      calls += 1;
      if (calls === 1) throw executeError;
      throw criticError;
    },
  };
  const runner = new CycleRunner({
    gateway,
    artistPerformer: performerWithErrors,
    criticPerformer: performerWithErrors,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  const artistDescription = (await fixture.gateway.get_issue(outcome.artist.id)).description;
  const criticDescription = (await fixture.gateway.get_issue(outcome.criticIssue.id)).description;
  assert.match(artistDescription, /## Role\n\nArtist/u);
  assert.match(artistDescription, /## Artist Result\n- Result: failure/u);
  assert.equal(artistDescription.includes([
    "## Artist Result",
    "- Result: failure",
    `- Error: ${executeError.message.slice(0, 50)}`,
  ].join("\n")), true);
  assert.doesNotMatch(artistDescription, /Launch status|Duration ms|Exit code|Process reason|private-cause|performer_/u);
  assert.match(criticDescription, /## Role\n\nCritic/u);
  assert.match(criticDescription, /## Critic Result/u);
  assert.match(criticDescription, /- Verdict: process_error/u);
  assert.equal(criticDescription.includes(criticError.message.slice(0, 50)), true);
  assert.doesNotMatch(criticDescription, /private-critique-cause|critic_process/u);
  assert.equal(comments.some(([issueId]) => issueId === outcome.artist.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.criticIssue.id), false);
  if (outcome.critique.verdict !== "process_error") throw new Error("expected critique process error");
  assert.equal(outcome.critique.reason, criticError.message.slice(0, 50));
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001-critique-result.json"), "utf8")), outcome.critique);
});

test("keeps Artist Markdown mechanical when its final response reference is wrong", async () => {
  const fixture = await world();
  const comments: Array<readonly [string, string]> = [];
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "create_comment") {
        return async (issueId: string, body: string) => {
          comments.push([issueId, body]);
          return target.create_comment(issueId, body);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rolePerformer: Performer = {
    async launch(request) {
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Artist prose is retained mechanically.\n", "utf8");
        return {
          launch_status: "exited", exit_code: 0, duration_ms: 1,
          final_response_ref: path.join(fixture.runDirectory, "wrong-artist-ref.md"),
        };
      }
      const critique = criticMarkdown({
        verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
      });
      await writeFile(request.final_response_path as string, critique, "utf8");
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 1,
        final_response_ref: request.final_response_path,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
  const runner = new CycleRunner({
    gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.terminal.result, "succeeded");
  const artistDescription = (await fixture.gateway.get_issue(outcome.artist.id)).description;
  assert.match(artistDescription, /Final response reference mismatch/u);
  assert.equal(artistDescription.includes("Artist prose is retained mechanically."), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.artist.id), false);
});

test("turns invalid UTF-8 Critic Markdown into process_error", async () => {
  const fixture = await world();
  const rolePerformer: Performer = {
    async launch(request) {
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Artist completed.\n", "utf8");
        return { launch_status: "exited", exit_code: 0, duration_ms: 1, final_response_ref: request.final_response_path };
      }
      await writeFile(request.final_response_path as string, Buffer.from([0xc3, 0x28]));
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 1,
        final_response_ref: request.final_response_path,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.critique.verdict, "process_error");
  assert.equal(outcome.terminal.result, "failed");
});

test("keeps safe malformed Critic Markdown raw while adding a mechanical process error", async () => {
  const fixture = await world();
  const comments: Array<readonly [string, string]> = [];
  const malformed = [
    "verdict: accepted", "", "## Scope Reviewed", "Inspected parser source.", "",
    "## Implementation Review", "The parser rejects ambiguity.", "", "## Checks", "- None",
    "", "## Evidence", "- None", "", "## Findings", "- None", "",
  ].join("\n");
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "create_comment") {
        return async (issueId: string, body: string) => {
          comments.push([issueId, body]);
          return target.create_comment(issueId, body);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rolePerformer: Performer = {
    async launch(request) {
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Artist completed.\n", "utf8");
        return { launch_status: "exited", exit_code: 0, duration_ms: 1, final_response_ref: request.final_response_path };
      }
      await writeFile(request.final_response_path as string, malformed, "utf8");
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 1,
        final_response_ref: request.final_response_path,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
  const runner = new CycleRunner({
    gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.critique.verdict, "process_error");
  const criticDescription = (await fixture.gateway.get_issue(outcome.criticIssue.id)).description;
  assert.equal(criticDescription.includes(malformed), true);
  assert.equal(criticDescription.includes("## Critic Result") && criticDescription.includes("process_error"), true);
  assert.equal(comments.some(([issueId]) => issueId === outcome.criticIssue.id), false);
  const cycleComment = comments.find(([issueId, body]) => (
    issueId === outcome.cycle.id && body.startsWith("## Cycle Result")
  ))?.[1] ?? "";
  assert.equal(cycleComment.includes(malformed), false);
  assert.deepEqual(fixture.gateway.attachments.map(({ filename }) => filename), ["cycle-001-critique-result.json"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001-critique-result.json"), "utf8")), outcome.critique);
});

test("projects valid final messages even after nonzero Artist and Critic exits", async () => {
  const fixture = await world();
  const comments: Array<readonly [string, string]> = [];
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "create_comment") {
        return async (issueId: string, body: string) => {
          comments.push([issueId, body]);
          return target.create_comment(issueId, body);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const criticRaw = criticMarkdown({ verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [] });
  const rolePerformer: Performer = {
    async launch(request) {
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Artist completed before nonzero exit.\n", "utf8");
        return {
          launch_status: "exited", exit_code: 2, duration_ms: 1,
          final_response_ref: request.final_response_path,
        };
      }
      await writeFile(request.final_response_path as string, criticRaw, "utf8");
      return {
        launch_status: "exited", exit_code: 3, duration_ms: 1,
        final_response_ref: request.final_response_path,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
  const runner = new CycleRunner({
    gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.terminal.result, "failed");
  const artistDescription = (await fixture.gateway.get_issue(outcome.artist.id)).description;
  const criticDescription = (await fixture.gateway.get_issue(outcome.criticIssue.id)).description;
  assert.equal(artistDescription.includes("Artist completed before nonzero exit.\n"), true);
  assert.equal(artistDescription.includes([
    "## Artist Result", "- Result: failure", "- Error: Process exited with code 2",
  ].join("\n")), true);
  assert.equal(criticDescription.includes(criticRaw), true);
  assert.equal(criticDescription.includes(
    "## Critic Result\n- Verdict: process_error\n- Error: Performer exited unsuccessfully",
  ), true);
  assert.equal(comments.some(([issueId]) => issueId === outcome.artist.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.criticIssue.id), false);
  assert.deepEqual(fixture.gateway.attachments.map(({ filename }) => filename), ["cycle-001-critique-result.json"]);
});

test("keeps role reports in Issue descriptions and links the uploaded Critique from Cycle", async () => {
  const fixture = await world();
  const comments: Array<readonly [string, string]> = [];
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "upload_file") {
        return async (filename: string) => ({ url: `https://linear.invalid/files/${filename}` });
      }
      if (property === "create_comment") {
        return async (issueId: string, body: string) => {
          comments.push([issueId, body]);
          return target.create_comment(issueId, body);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rolePerformer = performer([], { launch_status: "exited", exit_code: 0, duration_ms: 1 }, {
    verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
  });
  const runner = new CycleRunner({
    gateway,
    artistPerformer: rolePerformer,
    criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.terminal.result, "succeeded");
  const artistDescription = (await fixture.gateway.get_issue(outcome.artist.id)).description;
  const criticDescription = (await fixture.gateway.get_issue(outcome.criticIssue.id)).description;
  assert.equal(artistDescription.includes("Artist completed; this response is not Critic evidence.\n"), true);
  assert.equal(criticDescription.includes("verdict: accepted"), true);
  assert.equal(comments.some(([issueId]) => issueId === outcome.artist.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.criticIssue.id), false);
  const cycleComment = comments.find(([issueId, body]) => (
    issueId === outcome.cycle.id && body.startsWith("## Cycle Result")
  ))?.[1] ?? "";
  assert.equal(cycleComment.includes("cycle-001-artist-result.md"), false);
  assert.equal(cycleComment.includes("cycle-001-critic-result.md"), false);
  assert.equal(
    cycleComment.includes("[cycle-001-critique-result.json](https://linear.invalid/files/cycle-001-critique-result.json)"),
    true,
  );
  assert.deepEqual(fixture.gateway.attachments, []);
});

test("keeps Critique upload failures visible without changing the Cycle verdict", async () => {
  const fixture = await world();
  const comments: Array<readonly [string, string]> = [];
  const gateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property) {
      if (property === "upload_file") {
        return async () => { throw new Error("upload current message that must remain visible to operators"); };
      }
      if (property === "create_comment") {
        return async (issueId: string, body: string) => {
          comments.push([issueId, body]);
          return target.create_comment(issueId, body);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const rolePerformer = performer([], { launch_status: "exited", exit_code: 0, duration_ms: 1 }, {
    verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
  });
  const runner = new CycleRunner({
    gateway, artistPerformer: rolePerformer, criticPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.equal(outcome.terminal.result, "succeeded");
  const cycleComment = comments.find(([issueId, body]) => (
    issueId === outcome.cycle.id && body.startsWith("## Cycle Result")
  ))?.[1] ?? "";
  assert.equal(cycleComment.includes("- Critique: upload failed (upload current message that must remain visible to)"), true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001-critique-result.json"), "utf8")),
    outcome.critique,
  );
});

test("starts no Agent when complete family creation is not durably recorded", async () => {
  const fixture = await world();
  let creates = 0;
  const failingGateway = new Proxy(fixture.gateway as LinearGateway, {
    get(target, property, receiver) {
      if (property !== "create_issue") return Reflect.get(target, property, receiver) as unknown;
      return async (...args: Parameters<LinearGateway["create_issue"]>) => {
        creates += 1;
        if (creates === 3) throw new Error("linear_write_failed");
        return target.create_issue(...args);
      };
    },
  });
  let launches = 0;
  const neverPerformer: Performer = { launch: async () => { launches += 1; throw new Error("unexpected_launch"); } };
  const runner = new CycleRunner({
    gateway: failingGateway,
    artistPerformer: neverPerformer,
    criticPerformer: neverPerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  await assert.rejects(
    runner.run({
      rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
      transitionComment: fixture.transitionComment,
      onFamilyRecorded: async () => undefined,
    }),
    /linear_write_failed/u,
  );
  assert.equal(launches, 0);
});

test("starts no Agent when cursor persistence fails after family recording", async () => {
  const fixture = await world();
  let launches = 0;
  const neverPerformer: Performer = { launch: async () => { launches += 1; throw new Error("unexpected_launch"); } };
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    artistPerformer: neverPerformer,
    criticPerformer: neverPerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    artistAgent: "codex", criticAgent: "codex", timeoutMs: 1_000,
  });
  await assert.rejects(runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => { throw new Error("root_state_write_failed"); },
  }), /root_state_write_failed/u);
  assert.equal(launches, 0);
});
