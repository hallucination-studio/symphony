import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cleanup = path.resolve("tools/e2e/cleanup.mjs");

test("cleanup removes only the current run lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-e2e-cleanup-"));
  const lockRoot = path.join(root, "symphony-core-live-global");
  const lock = path.join(lockRoot, ".symphony-e2e.lock");
  await mkdir(lockRoot);
  await writeFile(lock, '{"runId":"run-1"}\n');

  const result = spawnSync(process.execPath, [cleanup], {
    cwd: root,
    encoding: "utf8",
    env: { SYMPHONY_E2E_RUN_ID: "run-1", TMPDIR: root },
  });

  assert.equal(result.status, 0);
  await assert.rejects(access(lock));
});

test("cleanup preserves another run's lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "symphony-e2e-cleanup-"));
  const lockRoot = path.join(root, "symphony-core-live-global");
  const lock = path.join(lockRoot, ".symphony-e2e.lock");
  await mkdir(lockRoot);
  await writeFile(lock, '{"runId":"other-run"}\n');

  const result = spawnSync(process.execPath, [cleanup], {
    cwd: root,
    encoding: "utf8",
    env: { SYMPHONY_E2E_RUN_ID: "run-1", TMPDIR: root },
  });

  assert.equal(result.status, 0);
  await access(lock);
});
