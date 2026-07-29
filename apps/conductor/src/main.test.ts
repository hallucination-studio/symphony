import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

import { ConductorRuntime } from "./main.js";

test("minimal Conductor runtime starts and stops without external effects", () => {
  const runtime = new ConductorRuntime();

  assert.equal(runtime.status, "idle");
  runtime.start();
  assert.equal(runtime.status, "running");
  runtime.stop();
  assert.equal(runtime.status, "stopped");
  assert.throws(() => runtime.start(), /conductor_runtime_already_started/u);
});

test("Conductor process reports readiness and stops on SIGTERM", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const output = lines[Symbol.asyncIterator]();
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

  const ready = await output.next();
  assert.equal(ready.done, false);
  assert.deepEqual(JSON.parse(ready.value), { event: "conductor_ready" });
  assert.equal(child.kill("SIGTERM"), true);

  const stopped = await output.next();
  assert.equal(stopped.done, false);
  assert.deepEqual(JSON.parse(stopped.value), { event: "conductor_stopped" });
  const [code, signal] = await exit;
  assert.equal(signal, null);
  assert.equal(code, 0, Buffer.concat(stderr).toString("utf8"));
});
