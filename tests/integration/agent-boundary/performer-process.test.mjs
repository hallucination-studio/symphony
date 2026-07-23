import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const EVIDENCE_DEADLINE_MS = 300_000;
const SHUTDOWN_ASSERTION_MS = 2_000;
const RESPONSE_ASSERTION_MS = 5_000;
const PERFORMER = path.resolve(".venv/bin/performer");

test("production Performer rejects the retired envelope and exits on SIGTERM", {
  timeout: EVIDENCE_DEADLINE_MS,
}, async () => {
  const deadlineAt = Date.now() + EVIDENCE_DEADLINE_MS;
  const child = spawn(PERFORMER, ["--agent"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      PYTHONPATH: path.resolve("apps/performer/src"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  const outputState = { offset: 0 };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });

  try {
    await waitForSpawn(child, deadlineAt);
    child.stdin.write(`${JSON.stringify({
      protocol_version: "1",
      request_id: "retired-envelope",
      kind: "execute_plan_turn",
      payload: {},
    })}\n`);
    const response = await waitForJsonLine(child, () => output, outputState, Math.min(deadlineAt, Date.now() + RESPONSE_ASSERTION_MS), () => errors);
    assert.equal(response.kind, "error");
    assert.equal(response.code, "request_shape_invalid");

    child.stdin.write(`${JSON.stringify(rootObservation())}\n`);
    const directResponse = await waitForJsonLine(child, () => output, outputState, Math.min(deadlineAt, Date.now() + RESPONSE_ASSERTION_MS), () => errors);
    assert.equal(directResponse.kind, "error");
    assert.equal(directResponse.code, "session_not_found");

    child.kill("SIGTERM");
    const exit = await waitForExit(child, Math.min(deadlineAt, Date.now() + SHUTDOWN_ASSERTION_MS));
    assert.equal(exit.signal === "SIGTERM" || exit.code === 0, true);
  } finally {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function waitForSpawn(child, deadlineAt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("performer_spawn_timeout")), remaining(deadlineAt));
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForJsonLine(child, readOutput, outputState, deadlineAt, readErrors) {
  return new Promise((resolve, reject) => {
    let listener;
    const timer = setTimeout(() => {
      child.stdout.off("data", listener);
      reject(new Error(`performer_response_timeout:${readErrors()}`));
    }, remaining(deadlineAt));
    const check = () => {
      const fullOutput = readOutput();
      const nextLineEnd = fullOutput.indexOf("\n", outputState.offset);
      if (nextLineEnd < 0) return;
      const line = fullOutput.slice(outputState.offset, nextLineEnd);
      outputState.offset = nextLineEnd + 1;
      if (line === undefined) return;
      clearTimeout(timer);
      child.stdout.off("data", listener);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    listener = () => check();
    child.stdout.on("data", listener);
    check();
  });
}

function rootObservation() {
  return {
    protocol_version: "1",
    request_id: "root-observation",
    reconciler_session_id: "missing-session",
    reconciler_turn_id: "root-turn",
    observed_at: "2026-07-23T00:00:00Z",
    root: {
      issue: {
        issue_id: "root-1",
        issue_kind: "root",
        title: "Root",
        description: "Complete the root objective",
        status: "Todo",
        is_archived: false,
        remote_version: "root-v1",
      },
      objective: "Complete the root objective",
      scope: "The requested scope",
      acceptance_criteria: [{
        criterion_key: "criterion-1",
        statement: "The objective is complete",
        verification_method: "automated test",
      }],
      constraints: [],
      root_status: "Todo",
      ownership: { record_id: "owner-1", record_kind: "root_ownership", version: "1" },
      convergence_summary: "No convergence limit has been reached.",
    },
    cycles: [],
    root_human_actions: [],
    accepted_root_directives: [],
    root_reconciler_failures: [],
    pending_user_comments: [],
    reconciler_reply_records: [],
    external_linear_changes: [],
    workflow_change_resolutions: [],
    git_facts: { head_revision: "head-1", baseline_revision: "head-1", status_summary: "clean", changed_paths: [] },
    delivery: { record_id: "delivery-1", record_kind: "delivery", version: "1" },
    source_manifest: [],
    coverage: { is_complete: true, omissions: [] },
    observed_root_tree_digest: "tree-1",
    limits: {
      max_context_bytes: 1,
      max_result_bytes: 1,
      max_output_tokens: 1,
      max_tool_calls: 0,
      max_wall_time_ms: 1_000,
      deadline_at: "2027-07-23T00:00:00Z",
    },
  };
}

function waitForExit(child, deadlineAt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("performer_shutdown_timeout")), remaining(deadlineAt));
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function remaining(deadlineAt) {
  return Math.max(1, deadlineAt - Date.now());
}
