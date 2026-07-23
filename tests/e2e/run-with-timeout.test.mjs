import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const wrapper = "tools/e2e/run-with-timeout.mjs";

test("E2E command wrapper preserves a child exit code", () => {
  const result = spawnSync(process.execPath, [wrapper, "--", process.execPath, "-e", "process.exit(7)"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 7);
});

test("E2E command wrapper kills a stalled child before the configured deadline", () => {
  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [wrapper, "--timeout-ms", "30", "--", process.execPath, "-e", "setTimeout(() => {}, 60000)"],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(result.status, 124);
  assert.match(result.stderr, /target_command_timeout/u);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("E2E command wrapper force kills a child that ignores graceful termination", () => {
  const result = spawnSync(
    process.execPath,
    [wrapper, "--timeout-ms", "100", "--", process.execPath, "-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"],
    { encoding: "utf8", timeout: 2_000 },
  );
  assert.equal(result.status, 124);
  assert.match(result.stderr, /target_command_timeout/u);
});

test("E2E command wrapper kills detached descendants at the deadline", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "symphony-timeout-"));
  const pidPath = path.join(root, "detached.pid");
  const childCode = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
    "setTimeout(() => {}, 60000);",
  ].join(" ");
  try {
    const result = spawnSync(
      process.execPath,
      [wrapper, "--timeout-ms", "100", "--", process.execPath, "-e", childCode],
      { encoding: "utf8", timeout: 2_000 },
    );
    assert.equal(result.status, 124);
    assert.equal(existsSync(pidPath), true);
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    assert.fail(`detached child ${pid} survived the timeout`);
  } finally {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
