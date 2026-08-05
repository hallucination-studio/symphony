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
  executeResult: PerformerProcessResult,
  auditResponse: unknown,
): Performer {
  return {
    async launch(request) {
      launches.push(request);
      if (request.sandbox === "workspace_write") {
        if (request.final_response_path !== undefined && executeResult.launch_status === "exited" && executeResult.exit_code === 0) {
          await writeFile(request.final_response_path, "Executor completed; this response is not Audit evidence.\n", "utf8");
          return { ...executeResult, final_response_ref: request.final_response_path };
        }
        return executeResult;
      }
      assert.equal(request.sandbox, "read_only");
      const responsePath = request.final_response_path;
      assert.notEqual(responsePath, undefined);
      await writeFile(responsePath as string, auditMarkdown(auditResponse), "utf8");
      return {
        launch_status: "exited", exit_code: 0, duration_ms: 7,
        final_response_ref: responsePath as string,
        diagnostic_jsonl_ref: request.diagnostic_jsonl_path,
        diagnostic_stderr_ref: request.diagnostic_stderr_path,
      };
    },
  };
}

function auditMarkdown(value: unknown): string {
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
    "## Scope Audited", String(result.scope_audited ?? "The complete workspace diff."),
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

test("creates exact family and trusts only a fresh Audit", async () => {
  const fixture = await world();
  const launches: PerformerLaunchRequest[] = [];
  const rolePerformer = performer(launches, {
    launch_status: "exited", exit_code: 0, duration_ms: 4,
    diagnostic_jsonl_ref: "/external/diagnostics/execute.jsonl",
    diagnostic_stderr_ref: "/external/diagnostics/execute.stderr",
    thread_id: "thread-execute-must-stay-local",
  }, {
    verdict: "accepted", implementation_review: "Parser behavior is verified", checks: ["npm test"],
    evidence: ["test passes"], findings: [], task_state_markdown: "Parser ambiguity is rejected",
  });
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", executeModel: "execute-model", executeReasoningEffort: "high",
    auditModel: "audit-model", auditReasoningEffort: "xhigh", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.equal(outcome.terminal.result, "succeeded");
  assert.equal(outcome.audit.verdict, "accepted");
  assert.equal(launches.length, 2);
  assert.equal(launches[0]?.sandbox, "workspace_write");
  assert.equal(launches[0]?.model, "execute-model");
  assert.equal(launches[0]?.reasoning_effort, "high");
  assert.equal(launches[0]?.final_response_path, path.join(fixture.runDirectory, "cycle-001-executor-result.md"));
  assert.equal(launches[0]?.diagnostic_jsonl_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[0]?.diagnostic_stderr_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[1]?.sandbox, "read_only");
  assert.equal(launches[1]?.model, "audit-model");
  assert.equal(launches[1]?.reasoning_effort, "xhigh");
  assert.equal(launches[1]?.final_response_path, path.join(fixture.runDirectory, "cycle-001-audit-result.md"));
  assert.equal(launches[1]?.diagnostic_jsonl_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[1]?.diagnostic_stderr_path?.startsWith(fixture.runDirectory), true);
  assert.equal(launches[1]?.prompt.includes("thread-execute-must-stay-local"), false);
  assert.equal(launches[1]?.prompt.includes("execute.jsonl"), false);
  assert.equal(launches[1]?.prompt.includes("Parser behavior is verified"), false);
  assert.match(launches[0]?.prompt ?? "", /final response.*Markdown/iu);
  assert.match(launches[0]?.prompt ?? "", /## Summary[\s\S]*## File Changes[\s\S]*## Verification/u);
  assert.match(launches[0]?.prompt ?? "", /Do not copy raw Git porcelain status codes such as `\?\?`, `M`, or `D`/u);
  assert.doesNotMatch(launches[0]?.prompt ?? "", /## Objective\n|## Acceptance\n|## Boundaries\n|## Trusted Task State\n/u);
  assert.match(launches[1]?.prompt ?? "", /first line is `verdict: ` followed by exactly one/u);
  assert.match(launches[1]?.prompt ?? "", /## Scope Audited[\s\S]*## Implementation Review[\s\S]*## Checks/u);
  assert.doesNotMatch(launches[1]?.prompt ?? "", /## Summary\n/u);
  const descendants = await fixture.gateway.list_unfinished_descendants("root-id");
  assert.deepEqual(descendants, []);
  const cycleRecord = JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001.json"), "utf8")) as Record<string, unknown>;
  assert.equal(cycleRecord.cycle_id, outcome.cycle.id);
  assert.equal(cycleRecord.execute_id, outcome.execute.id);
  assert.equal(cycleRecord.audit_id, outcome.auditIssue.id);
  assert.deepEqual(cycleRecord.consumed_comment_ids, ["comment-1"]);
  const persistedAudit = await readFile(path.join(fixture.runDirectory, "cycle-001-audit-result.json"));
  assert.deepEqual(JSON.parse(persistedAudit.toString("utf8")), outcome.audit);
  assert.deepEqual(fixture.gateway.attachments.map(({ filename, content_type, contents }) => ({
    filename, content_type, contents: Buffer.from(contents).toString("utf8"),
  })), [{
    filename: "cycle-001-audit-result.json",
    content_type: "application/json",
    contents: persistedAudit.toString("utf8"),
  }]);
});

test("projects the Cycle, Execute, and Audit lifecycle statuses visibly", async () => {
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
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
    { title: "[Executor] Cycle 001", status_id: "todo-id" },
    { title: "[Audit] Cycle 001", status_id: "todo-id" },
  ]);
  assert.deepEqual(updates.map(([, statusId]) => statusId), [
    "active-id", "active-id", "completed-id", "review-id", "review-id", "completed-id", "completed-id",
  ]);
  assert.deepEqual(updates.map(([issueId]) => issueId), [
    "fake-issue-1", "fake-issue-2", "fake-issue-2", "fake-issue-1", "fake-issue-3", "fake-issue-3", "fake-issue-1",
  ]);
  const executorDescription = (await fixture.gateway.get_issue(outcome.execute.id)).description;
  const auditDescription = (await fixture.gateway.get_issue(outcome.auditIssue.id)).description;
  const cycleComments = comments.filter(([issueId]) => issueId === "fake-issue-1").map(([, body]) => body);
  assert.equal(cycleComments.length, 2);
  assert.equal(cycleComments[0], fixture.transitionComment);
  const cycleComment = cycleComments.find((body) => body.startsWith("## Cycle Result")) ?? "";
  assert.equal(executorDescription.includes("## Role\n\nExecute"), true);
  assert.equal(executorDescription.includes(
    `## Result\n\nUpdated at: ${updatedAtText}\n\nExecutor completed; this response is not Audit evidence.\n`,
  ), true);
  assert.equal(auditDescription.startsWith("## Role\n\nAudit"), true);
  assert.equal(auditDescription.includes(
    `## Result\n\nUpdated at: ${updatedAtText}\n\nverdict: accepted`,
  ), true);
  assert.equal(auditDescription.includes("## Scope Audited"), true);
  assert.equal(auditDescription.includes("## Implementation Review"), true);
  assert.equal(nowCalls, 2);
  assert.equal(comments.some(([issueId]) => issueId === outcome.execute.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.auditIssue.id), false);
  assert.equal(cycleComment.includes("## Cycle Result"), true);
  assert.equal(cycleComment.includes(`- Result: ${outcome.terminal.result}`), true);
  assert.equal(cycleComment.includes(`- Audit Issue: ${outcome.auditIssue.id}`), true);
  assert.equal(cycleComment.includes(`- Audit verdict: ${outcome.audit.verdict}`), true);
  assert.equal(cycleComment.includes(`- Reason: ${outcome.terminal.reason}`), true);
  assert.equal(cycleComment.includes(auditDescription), false);
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });

  await runner.run({
    rootId: "root-id", teamId: "team-id", spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.equal((creates[0] ?? "").length <= 80, true);
  assert.match(creates[0] ?? "", /^\[Cycle 001\] Objective /u);
  assert.equal(creates[1], "[Executor] Cycle 001");
  assert.equal(creates[2], "[Audit] Cycle 001");
});

test("rejects an Audit response too large to persist with Root State", async () => {
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.deepEqual(outcome.audit, { verdict: "process_error", reason: "Final response too large" });
  assert.equal(outcome.terminal.result, "failed");
});

test("audits residual workspace after Execute start failure", async () => {
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
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

test("audits residual workspace when the Execute adapter rejects", async () => {
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
    executePerformer: rejectingPerformer,
    auditPerformer: rejectingPerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.executeProcess.launch_status, "start_failed");
  assert.equal(outcome.executeProcess.sanitized_reason, "private_adapter_failure");
  assert.equal(outcome.terminal.result, "succeeded");
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.sandbox, "read_only");
});

test("fails the Cycle when Audit diagnostics are not durably referenced", async () => {
  const fixture = await world();
  const launches: PerformerLaunchRequest[] = [];
  const missingDiagnostics: Performer = {
    launch: async (request) => {
      launches.push(request);
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Executor completed.\n", "utf8");
        return {
          launch_status: "exited", exit_code: 0, duration_ms: 1,
          final_response_ref: request.final_response_path,
        };
      }
      await writeFile(request.final_response_path as string, auditMarkdown({
        verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
      }), "utf8");
      return { launch_status: "exited", exit_code: 0, duration_ms: 1, final_response_ref: request.final_response_path };
    },
  };
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    executePerformer: missingDiagnostics,
    auditPerformer: missingDiagnostics,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  assert.equal(launches.length, 2);
  assert.equal(outcome.audit.verdict, "process_error");
  assert.equal(outcome.audit.reason, "diagnostic_capture_failed");
  assert.equal(outcome.terminal.result, "failed");
});

test("bounds the mechanical Cycle reason without changing the Audit verdict", async () => {
  const fixture = await world();
  const rolePerformer = performer([], { launch_status: "exited", exit_code: 0, duration_ms: 1 }, {
    verdict: "accepted", implementation_review: "x".repeat(2_000), checks: [], evidence: [], findings: [],
    task_state_markdown: "Acceptance is verified",
  });
  const runner = new CycleRunner({
    gateway: fixture.gateway,
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.audit.verdict, "accepted");
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
    "executor-current-message-that-is-longer-than-fifty-characters-and-must-be-bounded",
    { cause: new Error("private-cause-must-not-be-visible") },
  );
  const auditError = new Error(
    "audit-current-message-that-is-longer-than-fifty-characters-and-must-be-bounded",
    { cause: new Error("private-audit-cause-must-not-be-visible") },
  );
  const performerWithErrors: Performer = {
    async launch() {
      calls += 1;
      if (calls === 1) throw executeError;
      throw auditError;
    },
  };
  const runner = new CycleRunner({
    gateway,
    executePerformer: performerWithErrors,
    auditPerformer: performerWithErrors,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });

  const executeDescription = (await fixture.gateway.get_issue(outcome.execute.id)).description;
  const auditDescription = (await fixture.gateway.get_issue(outcome.auditIssue.id)).description;
  assert.match(executeDescription, /## Role\n\nExecute/u);
  assert.match(executeDescription, /## Executor Result\n- Result: failure/u);
  assert.equal(executeDescription.includes([
    "## Executor Result",
    "- Result: failure",
    `- Error: ${executeError.message.slice(0, 50)}`,
  ].join("\n")), true);
  assert.doesNotMatch(executeDescription, /Launch status|Duration ms|Exit code|Process reason|private-cause|performer_/u);
  assert.match(auditDescription, /## Role\n\nAudit/u);
  assert.match(auditDescription, /## Audit Result/u);
  assert.match(auditDescription, /- Verdict: process_error/u);
  assert.equal(auditDescription.includes(auditError.message.slice(0, 50)), true);
  assert.doesNotMatch(auditDescription, /private-audit-cause|audit_process/u);
  assert.equal(comments.some(([issueId]) => issueId === outcome.execute.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.auditIssue.id), false);
  if (outcome.audit.verdict !== "process_error") throw new Error("expected audit process error");
  assert.equal(outcome.audit.reason, auditError.message.slice(0, 50));
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001-audit-result.json"), "utf8")), outcome.audit);
});

test("keeps Executor Markdown mechanical when its final response reference is wrong", async () => {
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
        await writeFile(request.final_response_path as string, "Executor prose is retained mechanically.\n", "utf8");
        return {
          launch_status: "exited", exit_code: 0, duration_ms: 1,
          final_response_ref: path.join(fixture.runDirectory, "wrong-executor-ref.md"),
        };
      }
      const audit = auditMarkdown({
        verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [],
      });
      await writeFile(request.final_response_path as string, audit, "utf8");
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });

  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.terminal.result, "succeeded");
  const executeDescription = (await fixture.gateway.get_issue(outcome.execute.id)).description;
  assert.match(executeDescription, /Final response reference mismatch/u);
  assert.equal(executeDescription.includes("Executor prose is retained mechanically."), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.execute.id), false);
});

test("turns invalid UTF-8 Audit Markdown into process_error", async () => {
  const fixture = await world();
  const rolePerformer: Performer = {
    async launch(request) {
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Executor completed.\n", "utf8");
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.audit.verdict, "process_error");
  assert.equal(outcome.terminal.result, "failed");
});

test("keeps safe malformed Audit Markdown raw while adding a mechanical process error", async () => {
  const fixture = await world();
  const comments: Array<readonly [string, string]> = [];
  const malformed = [
    "verdict: accepted", "", "## Scope Audited", "Inspected parser source.", "",
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
        await writeFile(request.final_response_path as string, "Executor completed.\n", "utf8");
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.audit.verdict, "process_error");
  const auditDescription = (await fixture.gateway.get_issue(outcome.auditIssue.id)).description;
  assert.equal(auditDescription.includes(malformed), true);
  assert.equal(auditDescription.includes("## Audit Result") && auditDescription.includes("process_error"), true);
  assert.equal(comments.some(([issueId]) => issueId === outcome.auditIssue.id), false);
  const cycleComment = comments.find(([issueId, body]) => (
    issueId === outcome.cycle.id && body.startsWith("## Cycle Result")
  ))?.[1] ?? "";
  assert.equal(cycleComment.includes(malformed), false);
  assert.deepEqual(fixture.gateway.attachments.map(({ filename }) => filename), ["cycle-001-audit-result.json"]);
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001-audit-result.json"), "utf8")), outcome.audit);
});

test("projects valid final messages even after nonzero Executor and Audit exits", async () => {
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
  const auditRaw = auditMarkdown({ verdict: "accepted", implementation_review: "Looks good", checks: [], evidence: [], findings: [] });
  const rolePerformer: Performer = {
    async launch(request) {
      if (request.sandbox === "workspace_write") {
        await writeFile(request.final_response_path as string, "Executor completed before nonzero exit.\n", "utf8");
        return {
          launch_status: "exited", exit_code: 2, duration_ms: 1,
          final_response_ref: request.final_response_path,
        };
      }
      await writeFile(request.final_response_path as string, auditRaw, "utf8");
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.terminal.result, "failed");
  const executeDescription = (await fixture.gateway.get_issue(outcome.execute.id)).description;
  const auditDescription = (await fixture.gateway.get_issue(outcome.auditIssue.id)).description;
  assert.equal(executeDescription.includes("Executor completed before nonzero exit.\n"), true);
  assert.equal(executeDescription.includes([
    "## Executor Result", "- Result: failure", "- Error: Process exited with code 2",
  ].join("\n")), true);
  assert.equal(auditDescription.includes(auditRaw), true);
  assert.equal(auditDescription.includes(
    "## Audit Result\n- Verdict: process_error\n- Error: Performer exited unsuccessfully",
  ), true);
  assert.equal(comments.some(([issueId]) => issueId === outcome.execute.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.auditIssue.id), false);
  assert.deepEqual(fixture.gateway.attachments.map(({ filename }) => filename), ["cycle-001-audit-result.json"]);
});

test("keeps role reports in Issue descriptions and links the uploaded Audit result from Cycle", async () => {
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
    executePerformer: rolePerformer,
    auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });
  const outcome = await runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => undefined,
  });
  assert.equal(outcome.terminal.result, "succeeded");
  const executeDescription = (await fixture.gateway.get_issue(outcome.execute.id)).description;
  const auditDescription = (await fixture.gateway.get_issue(outcome.auditIssue.id)).description;
  assert.equal(executeDescription.includes("Executor completed; this response is not Audit evidence.\n"), true);
  assert.equal(auditDescription.includes("verdict: accepted"), true);
  assert.equal(comments.some(([issueId]) => issueId === outcome.execute.id), false);
  assert.equal(comments.some(([issueId]) => issueId === outcome.auditIssue.id), false);
  const cycleComment = comments.find(([issueId, body]) => (
    issueId === outcome.cycle.id && body.startsWith("## Cycle Result")
  ))?.[1] ?? "";
  assert.equal(cycleComment.includes("cycle-001-executor-result.md"), false);
  assert.equal(cycleComment.includes("cycle-001-audit-result.md"), false);
  assert.equal(
    cycleComment.includes("[cycle-001-audit-result.json](https://linear.invalid/files/cycle-001-audit-result.json)"),
    true,
  );
  assert.deepEqual(fixture.gateway.attachments, []);
});

test("keeps Audit result upload failures visible without changing the Cycle verdict", async () => {
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
    gateway, executePerformer: rolePerformer, auditPerformer: rolePerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
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
  assert.equal(cycleComment.includes("- Audit result: upload failed (upload current message that must remain visible to)"), true);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(fixture.runDirectory, "cycle-001-audit-result.json"), "utf8")),
    outcome.audit,
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
    executePerformer: neverPerformer,
    auditPerformer: neverPerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
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
    executePerformer: neverPerformer,
    auditPerformer: neverPerformer,
    workflow: { todo_status_id: "todo-id", in_progress_status_id: "active-id", in_review_status_id: "review-id", done_status_id: "completed-id", canceled_status_id: "canceled-id" },
    agent: "codex", timeoutMs: 1_000,
  });
  await assert.rejects(runner.run({
    rootId: "root-id", teamId: "team-id", spec: fixture.spec, rootState: fixture.rootState,
    transitionComment: fixture.transitionComment,
    onFamilyRecorded: async () => { throw new Error("root_state_write_failed"); },
  }), /root_state_write_failed/u);
  assert.equal(launches, 0);
});
