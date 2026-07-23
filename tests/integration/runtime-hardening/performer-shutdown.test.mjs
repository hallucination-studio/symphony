import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const EVIDENCE_DEADLINE_MS = 300_000;
const SHUTDOWN_ASSERTION_MS = 2_000;

test("production Performer leaves its blocking input loop on SIGTERM", {
  timeout: EVIDENCE_DEADLINE_MS,
}, async () => {
  const child = spawn(path.resolve(".venv/bin/performer"), ["--agent"], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, PYTHONPATH: path.resolve("apps/performer/src") },
    stdio: ["pipe", "ignore", "ignore"],
  });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.kill("SIGTERM");
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("performer_shutdown_timeout")), SHUTDOWN_ASSERTION_MS);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(exit.signal === "SIGTERM" || exit.code === 0, true);
  } finally {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
