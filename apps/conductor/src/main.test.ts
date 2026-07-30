import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";

test("public process fails closed on missing startup input without reporting ready", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.deepEqual(JSON.parse(Buffer.concat(stderr).toString("utf8")), {
    event: "conductor_failed",
    reason_code: "invalid_startup_arguments",
  });
});

test("public process remains inert after valid startup until the replacement runtime is wired", { timeout: 10_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-inert-main-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "conductor.json");
  await writeFile(configPath, JSON.stringify({
    linear_team_id: "team-1",
    program_data_path: path.join(directory, "program-data"),
    performer_home: path.join(directory, "performer-home"),
    codex_executable: "/usr/local/bin/codex",
    delivery_provider_endpoint: "https://api.github.com",
    root_routing: [{
      root_id: "ROOT-1",
      repository_id: "repo-1",
      repository_path: path.join(directory, "repository"),
      base_branch: "main",
    }],
  }), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--config", configPath], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      SYMPHONY_LINEAR_TOKEN: "inert-linear-token",
      SYMPHONY_CODEX_API_KEY: "inert-codex-key",
      SYMPHONY_CODEX_BASE_URL: "https://api.example.test/v1",
      SYMPHONY_CODEX_MODEL: "inert-model",
    },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];

  assert.equal(signal, null);
  assert.equal(code, 1);
  assert.equal(Buffer.concat(stdout).toString("utf8"), "");
  assert.deepEqual(JSON.parse(Buffer.concat(stderr).toString("utf8")), {
    event: "conductor_failed",
    reason_code: "target_runtime_not_ready",
  });
});
