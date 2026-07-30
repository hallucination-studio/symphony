import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { parseRepositoryId, parseRootIssueId } from "./contracts/identity.js";
import type { RootCandidate } from "./linear/api/LinearGatewayInterface.js";
import { runForeground } from "./main.js";

test("foreground loop retires fresh Done runtimes, ticks serially, and closes all on stop", async () => {
  const rootId = parseRootIssueId("ROOT-1");
  const candidate: RootCandidate = {
    root_id: rootId,
    status: "Done",
    priority: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    repository_id: parseRepositoryId("repo-1"),
    base_branch: "main",
  };
  const effects: string[] = [];
  let stopping = false;
  await runForeground({
    linear: { discoverRoots: () => Promise.resolve([candidate]) },
    runtimes: {
      has: () => true,
      closeAll: () => { effects.push("close_all"); return Promise.resolve(); },
    },
    retirement: {
      retireIfDone: () => { effects.push("retire"); return Promise.resolve({ kind: "retired" } as never); },
    },
    serial: {
      tick: () => { effects.push("tick"); return Promise.resolve({ kind: "idle" }); },
    },
  } as never, {
    stopRequested: () => stopping,
    wait: () => { effects.push("wait"); stopping = true; return Promise.resolve(); },
  });
  assert.deepEqual(effects, ["retire", "tick", "wait", "close_all"]);
});

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
    reason_code: "startup_or_runtime_failed",
  });
});
