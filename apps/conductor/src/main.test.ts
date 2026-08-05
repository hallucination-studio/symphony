import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runMain } from "./main.js";

test("the public process exposes only the Root-run grammar", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "cycle"], {
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
  const failure = JSON.parse(Buffer.concat(stderr).toString("utf8")) as Record<string, unknown>;
  assert.equal(failure.event, "conductor_failed");
  assert.equal(failure.reason_code, "invalid_startup_arguments");
  assert.match(String(failure.run_id), /^[0-9a-f-]{36}$/u);
  assert.deepEqual(Object.keys(failure).sort(), ["event", "reason_code", "run_id"]);
});

test("runtime failures publish only a diagnostic reference and retain the original cause", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-main-diagnostic-"));
  const workspace = path.join(base, "workspace");
  const runDirectory = path.join(base, "run");
  await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
  context.after(() => rm(base, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json-provider-context", {
    status: 502,
    statusText: "Bad Gateway",
  });
  context.after(() => { globalThis.fetch = originalFetch; });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const code = await runMain([
    "run", "--linear-root", "ENG-1", "--workspace", workspace,
    "--dir", runDirectory, "--max-cycles", "1",
  ], { LINEAR_API_KEY: "test-only" }, stdout, stderr);

  assert.equal(code, 1);
  assert.equal(Buffer.concat(stdoutChunks).toString("utf8"), "");
  const failure = JSON.parse(Buffer.concat(stderrChunks).toString("utf8")) as Record<string, unknown>;
  assert.equal(failure.reason_code, "linear_graphql_http_failed");
  assert.equal(typeof failure.diagnostic_ref, "string");
  assert.deepEqual(Object.keys(failure).sort(), ["diagnostic_ref", "event", "reason_code", "run_id"]);

  const evidence = await readFile(String(failure.diagnostic_ref), "utf8");
  assert.match(evidence, /not-json-provider-context/u);
  assert.match(evidence, /linear_graphql_http_failed/u);
  assert.doesNotMatch(Buffer.concat(stderrChunks).toString("utf8"), /not-json-provider-context/u);
});

test("runtime failures keep the current message when diagnostic capture also fails", async (context) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-main-diagnostic-failure-"));
  const workspace = path.join(base, "workspace");
  const invalidRunDirectory = path.join(base, "run-file");
  await mkdir(workspace);
  await writeFile(invalidRunDirectory, "not a directory");
  context.after(() => rm(base, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("provider-context-must-not-leak", { status: 502 });
  context.after(() => { globalThis.fetch = originalFetch; });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stderrChunks: Buffer[] = [];
  stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const code = await runMain([
    "run", "--linear-root", "ENG-1", "--workspace", workspace,
    "--dir", invalidRunDirectory, "--max-cycles", "1",
  ], { LINEAR_API_KEY: "test-only" }, stdout, stderr);

  assert.equal(code, 1);
  const source = Buffer.concat(stderrChunks).toString("utf8");
  const failure = JSON.parse(source) as Record<string, unknown>;
  assert.equal(failure.reason_code, "linear_graphql_http_failed");
  assert.equal(failure.diagnostic_ref, undefined);
  assert.doesNotMatch(source, /provider-context-must-not-leak/u);
});
