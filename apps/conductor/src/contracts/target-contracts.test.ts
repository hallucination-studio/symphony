import assert from "node:assert/strict";
import test from "node:test";

import {
  parseAgentKind,
  parseCritiqueVerdict,
  parseCycleIssueId,
  parseCycleResult,
  parseArtistIssueId,
  parseIssueStatus,
  parseRootIssueId,
  parseCriticIssueId,
  parseCommentId,
} from "./identity.js";
import {
  parseHarnessRunRequest,
  type HarnessRunRequest,
} from "./harness.js";
import {
  parseLinearComment,
  parseLinearIssue,
  parseLinearWorkflow,
} from "./task-management.js";
import {
  parseCycleSpec,
  parseCycleTerminalResult,
  parseCritiqueResult,
} from "./cycle.js";
import {
  parseRootReconcileDecision,
  parseRootReconcileRequest,
  parseRootState,
  parseRootWorktreeSummary,
} from "./root.js";
import {
  parsePerformerLaunchRequest,
  parsePerformerProcessResult,
} from "./performer.js";
import { parseDelivery, parseRootWorkspace } from "./workspace.js";

const issue = {
  id: "issue-root-1",
  identifier: "ENG-123",
  title: "Ship the parser",
  description: "Implement the bounded parser.",
  url: "https://linear.example/issue/ENG-123",
  status: "active",
  status_id: "state-active",
  parent_id: null,
  team_id: "team-eng",
  creator_id: "user-1",
} as const;

const comment = {
  id: "comment-1",
  issue_id: issue.id,
  body: "Please include the failure case.",
  creator_id: "user-2",
  created_at: "2026-08-05T00:00:00.000Z",
} as const;

const rootState = {
  workspace_path: "/workspaces/ENG-123",
  run_directory: "/runs/ENG-123",
  root_branch: "symphony/ENG-123",
  current_phase: "idle",
  task_state_markdown: "## Task State\n\nThe parser is not verified.",
  pending_finding: "The failure case is not covered.",
  harness_feedback: "",
  comment_cursor: comment.id,
} as const;

test("identity values are provider strings with closed status vocabularies", () => {
  assert.equal(parseRootIssueId("ENG-123"), "ENG-123");
  assert.equal(parseCycleIssueId("issue-cycle-1"), "issue-cycle-1");
  assert.equal(parseArtistIssueId("issue-execute-1"), "issue-execute-1");
  assert.equal(parseCriticIssueId("issue-audit-1"), "issue-audit-1");
  assert.equal(parseCommentId("comment-1"), "comment-1");
  assert.equal(parseAgentKind("codex"), "codex");
  assert.equal(parseIssueStatus("completed"), "completed");
  assert.equal(parseCycleResult("failed"), "failed");
  assert.equal(parseCritiqueVerdict("process_error"), "process_error");

  for (const parse of [
    parseRootIssueId,
    parseCycleIssueId,
    parseArtistIssueId,
    parseCriticIssueId,
    parseCommentId,
  ]) {
    assert.throws(() => parse(""), /invalid_provider_id/u);
    assert.throws(() => parse("contains\nnewline"), /invalid_provider_id/u);
  }
  assert.throws(() => parseAgentKind("claude"), /invalid_contract_variant/u);
  assert.throws(() => parseIssueStatus("in_progress"), /invalid_contract_variant/u);
  assert.throws(() => parseCycleResult("awaiting_acceptance"), /invalid_contract_variant/u);
  assert.throws(() => parseCritiqueVerdict("passed"), /invalid_contract_variant/u);
});

test("HarnessRunRequest is exact, bounded, and does not carry credentials", () => {
  const request: HarnessRunRequest = parseHarnessRunRequest({
    linear_root: "ENG-123",
    workspace_path: "/workspaces/ENG-123",
    run_directory: "/runs/ENG-123",
    reconcile_agent: "codex",
    reconcile_model: "reconcile-model",
    reconcile_reasoning_effort: "medium",
    artist_agent: "codex",
    artist_model: "execute-model",
    artist_reasoning_effort: "high",
    critic_agent: "codex",
    critic_model: "audit-model",
    critic_reasoning_effort: "xhigh",
    max_cycles: 30,
  });
  assert.deepEqual(request, {
    linear_root: "ENG-123",
    workspace_path: "/workspaces/ENG-123",
    run_directory: "/runs/ENG-123",
    reconcile_agent: "codex",
    reconcile_model: "reconcile-model",
    reconcile_reasoning_effort: "medium",
    artist_agent: "codex",
    artist_model: "execute-model",
    artist_reasoning_effort: "high",
    critic_agent: "codex",
    critic_model: "audit-model",
    critic_reasoning_effort: "xhigh",
    max_cycles: 30,
  });
  assert.ok(Object.isFrozen(request));
  for (const extra of [
    { linear_token: "do-not-expose" },
    { task: "local mode" },
    { round: 1 },
  ]) {
    assert.throws(() => parseHarnessRunRequest({ ...request, ...extra }), /invalid_contract_keys/u);
  }
  assert.throws(() => parseHarnessRunRequest({ ...request, agent: "codex" }), /invalid_contract_keys/u);
  assert.throws(() => parseHarnessRunRequest({ ...request, reconcile_agent: "claude" }), /invalid_contract_variant/u);
  assert.throws(() => parseHarnessRunRequest({ ...request, critic_agent: null }), /invalid_contract_variant/u);
  assert.throws(() => parseHarnessRunRequest({ ...request, max_cycles: 0 }), /invalid_max_cycles/u);
  assert.throws(() => parseHarnessRunRequest({ ...request, workspace_path: "relative" }), /invalid_workspace_path/u);
  assert.deepEqual(parseHarnessRunRequest({
    linear_root: "ENG-123", workspace_path: "/workspaces/ENG-123",
    run_directory: "/runs/ENG-123", max_cycles: 30,
  }), {
    linear_root: "ENG-123", workspace_path: "/workspaces/ENG-123",
    run_directory: "/runs/ENG-123", reconcile_agent: "codex", artist_agent: "codex", critic_agent: "codex", max_cycles: 30,
  });
  assert.deepEqual(parseHarnessRunRequest({
    linear_root: "ENG-123", workspace_path: "/workspaces/ENG-123",
    run_directory: "/runs/ENG-123", reconcile_reasoning_effort: "high", artist_model: "execute-only",
    critic_reasoning_effort: "xhigh", max_cycles: 1,
  }), {
    linear_root: "ENG-123", workspace_path: "/workspaces/ENG-123",
    run_directory: "/runs/ENG-123", reconcile_agent: "codex", reconcile_reasoning_effort: "high",
    artist_agent: "codex", artist_model: "execute-only", critic_agent: "codex",
    critic_reasoning_effort: "xhigh", max_cycles: 1,
  });
});

test("Linear values and RootState normalize provider data without provider payloads", () => {
  const parsedIssue = parseLinearIssue(issue);
  const parsedComment = parseLinearComment(comment);
  const workflow = parseLinearWorkflow({
    team_id: issue.team_id,
    todo_status_id: "state-todo",
    in_progress_status_id: "state-active",
    in_review_status_id: "state-review",
    done_status_id: "state-completed",
    canceled_status_id: "state-canceled",
  });
  const parsedState = parseRootState(rootState);

  assert.deepEqual(parsedIssue, issue);
  assert.deepEqual(parsedComment, comment);
  assert.equal(workflow.team_id, issue.team_id);
  assert.equal(parsedState.comment_cursor, comment.id);
  assert.equal(parseRootState({ ...rootState, delivery: { kind: "branch", branch: "root/ENG-123" } }).delivery?.kind, "branch");
  assert.ok(Object.isFrozen(parsedIssue));
  assert.ok(Object.isFrozen(parsedComment));
  assert.ok(Object.isFrozen(workflow));
  assert.ok(Object.isFrozen(parsedState));

  assert.throws(() => parseLinearIssue({ ...issue, metadata: {} }), /invalid_contract_keys/u);
  assert.throws(() => parseLinearComment({ ...comment, authorization: "secret" }), /invalid_contract_keys/u);
  assert.throws(() => parseRootState({ ...rootState, raw_trajectory: "secret" }), /invalid_contract_keys/u);
  assert.throws(() => parseRootState({ ...rootState, delivery: { kind: "branch", branch: "" } }), /invalid_delivery_branch/u);
});

test("RootState optionally persists a structured latest Critique", () => {
  const latestCritic = {
    verdict: "accepted",
    scope_reviewed: "Parser source, focused tests, and the complete workspace diff.",
    implementation_review: "The parser rejects ambiguous input before token recovery.",
    checks: ["npm test"],
    evidence: ["Focused test passed."],
    findings: [],
    task_state_markdown: "## Task State\n\nParser verified.",
  } as const;
  const parsed = parseRootState({ ...rootState, latest_critique: latestCritic });

  assert.deepEqual(parsed.latest_critique, latestCritic);
  assert.ok(Object.isFrozen(parsed.latest_critique));
  assert.ok(Object.isFrozen(parsed.latest_critique?.checks));
  assert.deepEqual(
    parseRootState({
      ...rootState,
      latest_critique: { verdict: "process_error", reason: "critic_start_failed" },
    }).latest_critique,
    { verdict: "process_error", reason: "critic_start_failed" },
  );
  assert.throws(() => parseRootState({
    ...rootState,
    latest_critique: { ...latestCritic, unexpected: "child-report" },
  }), /invalid_contract_keys/u);
});

test("Cycle and Root Reconcile values remain immutable and consume comments as a batch", () => {
  const spec = parseCycleSpec({
    cycle_number: 1,
    objective: "Implement one parser behavior.",
    acceptance: "A fresh read-only check proves the failure case.",
    boundaries: "Only the parser module may change.",
    consumed_comment_ids: [comment.id],
  });
  assert.deepEqual(spec.consumed_comment_ids, [comment.id]);
  assert.ok(Object.isFrozen(spec));
  assert.ok(Object.isFrozen(spec.consumed_comment_ids));

  const request = parseRootReconcileRequest({
    phase: "reconcile",
    root: issue,
    root_state: rootState,
    new_root_comments: [comment],
    worktree_summary: {
      status: "available",
      created: [{ path: "src/parser.ts", added_lines: 8, deleted_lines: 0 }],
      updated: [], deleted: [], insertions: 8, deletions: 0,
    },
  });
  assert.equal(request.new_root_comments.length, 1);
  assert.ok(Object.isFrozen(request.new_root_comments));
  assert.throws(() => parseRootReconcileRequest({
    root: issue,
    root_state: rootState,
    new_root_comments: [comment],
    child_tree: [],
  }), /invalid_contract_keys/u);

  const cycleDecision = parseRootReconcileDecision({
    kind: "create_cycle",
    cycle: {
      objective: spec.objective,
      acceptance: spec.acceptance,
      boundaries: spec.boundaries,
    },
    report: [
      "### Why Continue", "The pending finding remains open.", "",
      "### Evidence", "The latest Critic found an ambiguity.", "",
      "### Next Cycle", "Reject the ambiguous parser input.",
    ].join("\n"),
  });
  assert.equal(cycleDecision.kind, "create_cycle");
  assert.throws(() => parseRootReconcileDecision({
    kind: "create_cycle",
    cycle: { ...cycleDecision.cycle, consumed_comment_ids: [comment.id] },
  }), /invalid_contract_keys/u);
  const completeReport = [
    "### Overview", "The complete workspace is verified.", "",
    "### File Changes", "#### Created", "- src/parser.ts: +8 lines", "#### Updated", "- None", "#### Deleted", "- None", "",
    "### Line Changes", "+8 / -0 lines", "",
    "### Verification", "- npm test passed", "",
    "### Token Usage", "Total tokens: 1.2k",
  ].join("\n");
  const delivery = { kind: "files", workspace_path: "/workspaces/ENG-123", files: ["src/parser.ts"] } as const;
  assert.deepEqual(parseRootReconcileDecision({ kind: "complete", summary: "Complete.", delivery, report: completeReport }), {
    kind: "complete",
    summary: "Complete.",
    report: completeReport,
    delivery,
  });
  const reportAwaitingMechanicalTokenUsage = completeReport.replace("Total tokens: 1.2k", "").trimEnd();
  assert.deepEqual(parseRootReconcileDecision({
    kind: "complete",
    summary: "Complete with token usage pending mechanical projection.",
    delivery,
    report: reportAwaitingMechanicalTokenUsage,
  }), {
    kind: "complete",
    summary: "Complete with token usage pending mechanical projection.",
    report: reportAwaitingMechanicalTokenUsage,
    delivery,
  });
  const reportWithTrustedMechanicalJson = completeReport
    .replace("#### Created\n- src/parser.ts: +8 lines\n#### Updated\n- None\n#### Deleted\n- None", JSON.stringify({
      status: "available",
      created: [{ path: "src/parser.ts", added_lines: 8, deleted_lines: 0 }],
      updated: [],
      deleted: [],
    }, null, 2))
    .replace("+8 / -0 lines", JSON.stringify({ insertions: 8, deletions: 0 }, null, 2));
  assert.equal(parseRootReconcileDecision({
    kind: "complete", summary: "Complete.", delivery, report: reportWithTrustedMechanicalJson,
  }).report, reportWithTrustedMechanicalJson);
  assert.deepEqual(parseRootReconcileDecision({
    kind: "needs_human",
    reason: "Need a decision.",
    question: "Should the boundary expand?",
    report: [
      "### Reason", "The requested boundary is ambiguous.", "",
      "### Question", "Should the boundary expand?", "",
      "### Next Step", "Wait for a new Root comment.",
    ].join("\n"),
  }), {
    kind: "needs_human",
    reason: "Need a decision.",
    question: "Should the boundary expand?",
    report: [
      "### Reason", "The requested boundary is ambiguous.", "",
      "### Question", "Should the boundary expand?", "",
      "### Next Step", "Wait for a new Root comment.",
    ].join("\n"),
  });
  assert.deepEqual(parseRootWorktreeSummary({
    status: "unavailable", reason: "Git status was unavailable.",
  }), { status: "unavailable", reason: "Git status was unavailable." });
  assert.throws(() => parseRootWorktreeSummary({
    status: "available", created: [{ path: "src/parser.ts", added_lines: 8, deleted_lines: 0 }],
    updated: [], deleted: [], insertions: 9, deletions: 0,
  }), /invalid_root_worktree_line_totals/u);
});

test("Performer and Critic contracts keep process facts separate from semantic verdicts", () => {
  const launch = parsePerformerLaunchRequest({
    agent: "codex",
    model: "gpt-5.6-luna",
    reasoning_effort: "max",
    prompt: "Run the frozen task.",
    working_directory: "/workspaces/ENG-123",
    sandbox: "workspace_write",
    final_response_path: "/runs/ENG-123/response.txt",
    timeout_ms: 120_000,
  });
  assert.equal(launch.sandbox, "workspace_write");
  assert.ok(Object.isFrozen(launch));
  assert.throws(() => parsePerformerLaunchRequest({
    ...launch,
    task_manager_token: "secret",
  }), /invalid_contract_keys/u);

  const processResult = parsePerformerProcessResult({
    launch_status: "exited",
    exit_code: 0,
    duration_ms: 1_234,
    final_response_ref: "/runs/ENG-123/response.txt",
    token_usage: {
      input_tokens: 100,
      cached_input_tokens: 12,
      cache_write_input_tokens: 4,
      output_tokens: 25,
      reasoning_output_tokens: 9,
      total_tokens: 125,
    },
  });
  assert.equal(processResult.launch_status, "exited");
  assert.deepEqual(processResult.token_usage, {
    input_tokens: 100,
    cached_input_tokens: 12,
    cache_write_input_tokens: 4,
    output_tokens: 25,
    reasoning_output_tokens: 9,
    total_tokens: 125,
  });
  assert.ok(Object.isFrozen(processResult.token_usage));
  assert.throws(() => parsePerformerProcessResult({
    launch_status: "exited",
    duration_ms: 1,
    output: "model prose",
  }), /invalid_contract_keys/u);
  assert.throws(() => parsePerformerProcessResult({
    launch_status: "exited",
    duration_ms: 1,
    token_usage: {
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 126,
    },
  }), /invalid_total_tokens/u);
  assert.throws(() => parsePerformerProcessResult({
    launch_status: "exited",
    duration_ms: 1,
    token_usage: {
      input_tokens: Number.MAX_SAFE_INTEGER,
      output_tokens: 1,
      total_tokens: Number.MAX_SAFE_INTEGER,
    },
  }), /invalid_total_tokens/u);

  const audit = parseCritiqueResult({
    verdict: "accepted",
    scope_reviewed: "Parser source, focused tests, and the complete workspace diff.",
    implementation_review: "The parser rejects ambiguous input before token recovery.",
    checks: ["npm test"],
    evidence: ["Focused test passed."],
    findings: [],
    task_state_markdown: "## Task State\n\nParser verified.",
  });
  assert.equal(audit.verdict, "accepted");
  assert.ok(Object.isFrozen(audit));
  assert.deepEqual(parseCritiqueResult({ verdict: "process_error", reason: "critic_start_failed" }), {
    verdict: "process_error",
    reason: "critic_start_failed",
  });
  assert.throws(() => parseCritiqueResult({
    verdict: "accepted",
    scope_reviewed: "scope",
    implementation_review: "logic",
    checks: [],
    evidence: [],
    findings: [],
    reason: "unexpected",
  }), /invalid_contract_keys/u);
});

test("Cycle terminal result maps closed Critic verdicts mechanically", () => {
  const criticIssueId = parseCriticIssueId("issue-audit-1");
  assert.deepEqual(parseCycleTerminalResult({
    result: "succeeded",
    critic_issue_id: criticIssueId,
    critic_verdict: "accepted",
    reason: "Accepted by the fresh Critic.",
  }), {
    result: "succeeded",
    critic_issue_id: criticIssueId,
    critic_verdict: "accepted",
    reason: "Accepted by the fresh Critic.",
  });
  assert.throws(() => parseCycleTerminalResult({
    result: "succeeded",
    critic_issue_id: criticIssueId,
    critic_verdict: "incomplete",
    reason: "not accepted",
  }), /cycle_result_verdict_mismatch/u);
  assert.throws(() => parseCycleTerminalResult({
    result: "rejected",
    critic_issue_id: criticIssueId,
    critic_verdict: "accepted",
    reason: "not accepted",
  }), /cycle_result_verdict_mismatch/u);
  for (const verdict of ["blocked", "violation", "process_error"] as const) {
    assert.equal(parseCycleTerminalResult({
      result: "failed",
      critic_issue_id: criticIssueId,
      critic_verdict: verdict,
      reason: "The Cycle failed.",
    }).result, "failed");
  }
});

test("Root workspace and Delivery are closed values", () => {
  const workspace = parseRootWorkspace({
    workspace_path: "/workspaces/ENG-123",
    run_directory: "/runs/ENG-123",
    root_branch: "symphony/ENG-123",
  });
  assert.ok(Object.isFrozen(workspace));
  assert.deepEqual(parseDelivery({ kind: "pull_request", url: "https://github.example/pull/1", branch: workspace.root_branch }), {
    kind: "pull_request", url: "https://github.example/pull/1", branch: workspace.root_branch,
  });
  assert.deepEqual(parseDelivery({ kind: "branch", branch: workspace.root_branch, remote: "origin" }), {
    kind: "branch", branch: workspace.root_branch, remote: "origin",
  });
  assert.deepEqual(parseDelivery({ kind: "files", workspace_path: workspace.workspace_path, files: ["dist/result.txt"] }), {
    kind: "files", workspace_path: workspace.workspace_path, files: ["dist/result.txt"],
  });
  assert.throws(() => parseDelivery({ kind: "files", workspace_path: workspace.workspace_path, files: [] }), /invalid_delivery_files/u);
  assert.throws(() => parseDelivery({ kind: "branch", branch: workspace.root_branch, commit_hash: "deadbeef" }), /invalid_contract_keys/u);
});
