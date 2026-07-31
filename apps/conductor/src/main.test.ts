import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import type { ProductionConductor } from "./composition/ProductionConductor.js";
import { runForeground } from "./main.js";

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
  const failure = JSON.parse(Buffer.concat(stderr).toString("utf8")) as Record<string, unknown>;
  assert.equal(failure.event, "conductor_failed");
  assert.equal(failure.reason_code, "invalid_startup_arguments");
  assert.match(String(failure.correlation_id), /^process:[0-9a-f-]{36}$/u);
  assert.deepEqual(Object.keys(failure).sort(), ["correlation_id", "event", "reason_code"]);
});

test("foreground performs the immediate poll and waits only after the serial scheduler is idle", async () => {
  const order: string[] = [];
  let stopping = false;
  const production: ProductionConductor = {
    polling_interval_ms: 1_234,
    observer: {
      poll_once: async () => {
        order.push("poll");
        return [];
      },
    },
    scheduler: {
      admit: () => order.push("admit"),
      runNext: async () => {
        order.push("idle");
        return { kind: "idle" };
      },
    },
  };

  await runForeground(production, {
    stopRequested: () => stopping,
    wait: async (milliseconds) => {
      order.push(`wait:${milliseconds}`);
      stopping = true;
    },
  });

  assert.deepEqual(order, ["poll", "admit", "idle", "wait:1234"]);
});
