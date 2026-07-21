import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { JsonValue } from "@symphony/contracts";

import { ShortProcessPerformerStageClientImpl } from "../internal/ShortProcessPerformerStageClientImpl.js";

const fixturePath = new URL(
  "../../../../../packages/contracts/fixtures/cross-language/valid/stage-context.json",
  import.meta.url,
);

test("Stage client launches one short process and accepts correlated Events and Result", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-client-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-workspace-"));
  const envelope = await loadEnvelope();
  const observed: JsonValue[] = [];
  const script = await writeNodeScript(runtimeRoot, [
    "const fs = require('node:fs');",
    "const get = (name) => process.argv[process.argv.indexOf(name) + 1];",
    "const request = JSON.parse(fs.readFileSync(get('--request'), 'utf8'));",
    "const c = { protocol_version: request.protocol_version, stage_execution_id: request.stage_execution.stage_execution_id, stage: request.stage_execution.stage, root_issue_id: request.target.root_issue_id, cycle_issue_id: request.target.cycle_issue_id, node_issue_id: request.target.node_issue_id, context_digest: request.context_digest };",
    "process.stdout.write(JSON.stringify({ ...c, sequence: 0, occurred_at: '2026-07-21T09:00:01Z', body: { kind: 'started' } }) + '\\n');",
    "fs.writeFileSync(get('--result'), JSON.stringify({ ...c, completed_at: '2026-07-21T09:00:02Z', outcome: { kind: 'execution_failed', error_code: 'test_terminal', sanitized_reason: 'Test terminal result.', retryable: false } }));",
  ]);
  const client = createClient(runtimeRoot, script);

  const output = await client.runStage({
    envelope,
    workspaceRoot,
    onEvent(event) { observed.push(event as unknown as JsonValue); },
  });

  assert.equal((output.result as Record<string, unknown>).stage_execution_id, "execution-1");
  assert.equal((observed[0] as Record<string, unknown>).sequence, 0);
  assert.equal((observed[0] as Record<string, unknown>).stage, "plan");
  assert.deepEqual(await readdir(runtimeRoot), [path.basename(script)]);
  assert.equal(
    (await readFile(script, "utf8")).includes("workspace_root"),
    false,
  );
});

test("Stage client rejects a stale Event before accepting a Result", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-event-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-workspace-"));
  const envelope = await loadEnvelope();
  const script = await writeNodeScript(runtimeRoot, [
    "const fs = require('node:fs');",
    "const get = (name) => process.argv[process.argv.indexOf(name) + 1];",
    "const request = JSON.parse(fs.readFileSync(get('--request'), 'utf8'));",
    "const c = { protocol_version: request.protocol_version, stage_execution_id: request.stage_execution.stage_execution_id, stage: request.stage_execution.stage, root_issue_id: 'root-stale', cycle_issue_id: request.target.cycle_issue_id, node_issue_id: request.target.node_issue_id, context_digest: request.context_digest };",
    "process.stdout.write(JSON.stringify({ ...c, sequence: 0, occurred_at: '2026-07-21T09:00:01Z', body: { kind: 'started' } }) + '\\n');",
  ]);

  await assert.rejects(
    createClient(runtimeRoot, script).runStage({ envelope, workspaceRoot }),
    /performer_stage_event_correlation_invalid/u,
  );
});

for (const field of [
  "protocol_version",
  "stage_execution_id",
  "stage",
  "root_issue_id",
  "cycle_issue_id",
  "node_issue_id",
  "context_digest",
] as const) {
  test(`Stage client rejects a stale Result in ${field}`, async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-result-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-workspace-"));
    const envelope = await loadEnvelope();
    const script = await writeNodeScript(runtimeRoot, [
      "const fs = require('node:fs');",
      "const get = (name) => process.argv[process.argv.indexOf(name) + 1];",
      "const request = JSON.parse(fs.readFileSync(get('--request'), 'utf8'));",
      "const c = { protocol_version: request.protocol_version, stage_execution_id: request.stage_execution.stage_execution_id, stage: request.stage_execution.stage, root_issue_id: request.target.root_issue_id, cycle_issue_id: request.target.cycle_issue_id, node_issue_id: request.target.node_issue_id, context_digest: request.context_digest };",
      field === "protocol_version"
        ? "c.protocol_version = '2';"
        : field === "stage"
          ? "c.stage = 'work';"
          : `c.${field} = 'stale-${field}';`,
      "fs.writeFileSync(get('--result'), JSON.stringify({ ...c, completed_at: '2026-07-21T09:00:02Z', outcome: { kind: 'execution_failed', error_code: 'test_terminal', sanitized_reason: 'Test terminal result.', retryable: false } }));",
    ]);

    await assert.rejects(
      createClient(runtimeRoot, script).runStage({ envelope, workspaceRoot }),
      field === "protocol_version" ? /performer_stage_result_invalid/u : /performer_stage_result_correlation_invalid/u,
    );
  });
}

test("Stage client bounds stdout and stderr and reaps the process", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-output-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-workspace-"));
    const envelope = await loadEnvelope();
    const script = await writeNodeScript(runtimeRoot, [
      `process.${stream}.write('x'.repeat(1024 * 1024 + 1));`,
      "setInterval(() => {}, 1000);",
    ]);

    await assert.rejects(
      createClient(runtimeRoot, script).runStage({ envelope, workspaceRoot }),
      stream === "stdout"
        ? /performer_stage_event_frame_exceeded|performer_stage_event_bytes_exceeded/u
        : /performer_stderr_bytes_exceeded/u,
    );
  }
});

test("Stage client cancels and reaps a running process", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-cancel-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-workspace-"));
  const envelope = await loadEnvelope();
  const script = await writeNodeScript(runtimeRoot, ["setInterval(() => {}, 1000);"]);
  const client = createClient(runtimeRoot, script);
  const controller = new AbortController();
  const running = client.runStage({ envelope, workspaceRoot, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(running, /performer_stage_canceled/u);
  await client.cancelAndReap();
});

test("Stage client enforces the Stage wall-clock deadline", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-timeout-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "symphony-stage-workspace-"));
  const envelope = await loadEnvelope();
  (envelope as unknown as { limits: { max_wall_time_ms: number } }).limits.max_wall_time_ms = 1_000;
  const script = await writeNodeScript(runtimeRoot, ["setInterval(() => {}, 1000);"]);
  const startedAt = Date.now();

  await assert.rejects(
    createClient(runtimeRoot, script).runStage({ envelope, workspaceRoot }),
    /performer_stage_timeout/u,
  );
  assert.ok(Date.now() - startedAt >= 900);
});

async function loadEnvelope(): Promise<JsonValue> {
  const document = JSON.parse(await readFile(fixturePath, "utf8")) as { value: JsonValue };
  return document.value;
}

async function writeNodeScript(directory: string, lines: string[]): Promise<string> {
  const script = path.join(directory, "performer-test.js");
  await writeFile(script, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o700 });
  await chmod(script, 0o700);
  return script;
}

function createClient(runtimeRoot: string, script: string): ShortProcessPerformerStageClientImpl {
  return new ShortProcessPerformerStageClientImpl({
    executable: process.execPath,
    argumentsPrefix: [script],
    runtimeRoot,
    environment: () => ({ CODEX_HOME: "/isolated/profile" }),
    startupDeadlineMs: 1_000,
    cancellationGraceMs: 100,
  });
}
