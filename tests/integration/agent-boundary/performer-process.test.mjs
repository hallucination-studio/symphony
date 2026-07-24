import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const EVIDENCE_DEADLINE_MS = 300_000;
const SHUTDOWN_ASSERTION_MS = 2_000;
const RESPONSE_ASSERTION_MS = 5_000;
const PERFORMER = path.resolve(".venv/bin/performer");

test("production Performer rejects implicit Root turn input and exits on SIGTERM", {
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

    child.stdin.write(`${JSON.stringify({
      protocol_version: "1",
      request_id: "root-observation",
      reconciler_session_id: "missing-session",
      reconciler_turn_id: "root-turn",
      observed_at: "2026-07-23T00:00:00Z",
    })}\n`);
    const directResponse = await waitForJsonLine(child, () => output, outputState, Math.min(deadlineAt, Date.now() + RESPONSE_ASSERTION_MS), () => errors);
    assert.equal(directResponse.kind, "error");
    assert.equal(directResponse.code, "request_shape_invalid");

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
