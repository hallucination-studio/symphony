import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  parsePerformerLaunchRequest,
  type PerformerLaunchRequest,
} from "../../contracts/performer.js";
import {
  CodexCliPerformer,
  type CodexCliProcess,
  type CodexCliSpawn,
  type CodexCliSpawnOptions,
} from "./CodexCliPerformer.js";

interface FakeProcess extends CodexCliProcess {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly errors: PassThrough;
  readonly killSignals: NodeJS.Signals[];
  emit(event: string, ...args: readonly unknown[]): boolean;
  close(code: number | null, signal?: NodeJS.Signals | null): void;
}

function fakeSpawn(
  setup: (process: FakeProcess, args: readonly string[], options: CodexCliSpawnOptions) => void,
): { readonly spawn: CodexCliSpawn; readonly calls: readonly { executable: string; args: readonly string[]; cwd?: string | URL }[] } {
  const calls: { executable: string; args: readonly string[]; cwd?: string | URL }[] = [];
  const spawn: CodexCliSpawn = (executable, args, options) => {
    const events = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    const killSignals: NodeJS.Signals[] = [];
    const process = {
      stdin: input,
      stdout: output,
      stderr: errors,
      input,
      output,
      errors,
      killSignals,
      emit: events.emit.bind(events),
      once: events.once.bind(events),
      kill: (signal: NodeJS.Signals) => {
        killSignals.push(signal);
        return true;
      },
      close: (code: number | null, signal: NodeJS.Signals | null = null) => events.emit("close", code, signal),
    } as unknown as FakeProcess;
    calls.push({ executable, args: [...args], ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
    setup(process, args, options);
    return process;
  };
  return { spawn, calls };
}

function request(overrides: Record<string, unknown> = {}): PerformerLaunchRequest {
  return parsePerformerLaunchRequest({
    agent: "codex",
    model: "gpt-test",
    reasoning_effort: "high",
    prompt: "perform the frozen objective",
    working_directory: "/tmp/symphony-workspace",
    sandbox: "workspace_write",
    timeout_ms: 1_000,
    ...overrides,
  });
}

test("Codex CLI launch passes model, reasoning, prompt, working directory, and sandbox mechanically", async () => {
  let prompt = "";
  const fake = fakeSpawn((child, args, options) => {
    child.input.on("data", (chunk) => { prompt += chunk.toString("utf8"); });
    child.input.once("finish", () => child.close(0));
    assert.deepEqual(args, [
      "exec", "--json", "--ephemeral", "-c", "approval_policy=\"never\"", "--sandbox", "workspace-write",
      "--model", "gpt-test", "-c", "model_reasoning_effort=\"high\"",
      "-c", "openai_base_url=\"https://codex.example.test/v1\"",
      "--cd", "/tmp/symphony-workspace", "-",
    ]);
    assert.equal(options.env?.CODEX_API_KEY, "single-run-key");
    assert.equal(options.env?.OPENAI_API_KEY, undefined);
  });
  const performer = new CodexCliPerformer({
    executable: "/usr/local/bin/codex",
    spawn: fake.spawn,
    base_url: "https://codex.example.test/v1",
    environment: {
      PATH: "/usr/bin", HOME: "/tmp/home",
      CODEX_API_KEY: "single-run-key", OPENAI_API_KEY: "must-not-forward",
    },
  });

  const result = await performer.launch(request());
  assert.equal(result.launch_status, "exited");
  assert.equal(result.exit_code, 0);
  assert.equal(result.final_response_ref, undefined);
  assert.equal(prompt, "perform the frozen objective");
  assert.deepEqual(fake.calls, [{
    executable: "/usr/local/bin/codex",
      args: [
        "exec", "--json", "--ephemeral", "-c", "approval_policy=\"never\"", "--sandbox", "workspace-write",
        "--model", "gpt-test", "-c", "model_reasoning_effort=\"high\"",
        "-c", "openai_base_url=\"https://codex.example.test/v1\"",
        "--cd", "/tmp/symphony-workspace", "-",
    ],
    cwd: "/tmp/symphony-workspace",
  }]);
});

test("no_workspace uses a read-only Codex sandbox and skips Git repository discovery", async () => {
  const fake = fakeSpawn((child) => {
    child.input.once("finish", () => child.close(0));
  });
  const performer = new CodexCliPerformer({ spawn: fake.spawn });
  await performer.launch(request({ sandbox: "no_workspace" }));
  assert.equal(fake.calls[0]?.args.at(-2), "--skip-git-repo-check");
  assert.equal(fake.calls[0]?.args.at(-1), "-");
  assert.equal(fake.calls[0]?.args.includes("--cd"), true);
  assert.equal(fake.calls[0]?.args.includes("read-only"), true);
  assert.equal(fake.calls[0]?.args.some((value) => value.startsWith("openai_base_url=")), false);
});

test("omitted model and reasoning use the local Codex configuration", async () => {
  const fake = fakeSpawn((child, args) => {
    assert.equal(args.includes("--model"), false);
    assert.equal(args.some((value) => value.startsWith("model_reasoning_effort=")), false);
    assert.equal(args.includes("--ignore-user-config"), false);
    child.input.once("finish", () => child.close(0));
  });
  await new CodexCliPerformer({ spawn: fake.spawn }).launch(request({ model: undefined, reasoning_effort: undefined }));
});

test("Codex base URL rejects credentials and unsupported protocols before launch", () => {
  assert.throws(
    () => new CodexCliPerformer({ base_url: "https://user:secret@codex.example.test/v1" }),
    /invalid_codex_base_url/u,
  );
  assert.throws(
    () => new CodexCliPerformer({ base_url: "file:///tmp/codex" }),
    /invalid_codex_base_url/u,
  );
});

test("an optional final response is returned only as a bounded local reference", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const responsePath = path.join(temporary, "audit-response.md");
  const fake = fakeSpawn((child, args) => {
    const output = args[args.indexOf("--output-last-message") + 1];
    assert.equal(output, responsePath);
    child.input.once("finish", async () => {
      await writeFile(responsePath, "verdict: accepted\n", "utf8");
      child.close(0);
    });
  });
  const performer = new CodexCliPerformer({ spawn: fake.spawn });
  const result = await performer.launch(request({ final_response_path: responsePath }));
  assert.equal(result.final_response_ref, responsePath);
  assert.equal(await readFile(result.final_response_ref!, "utf8"), "verdict: accepted\n");
  assert.equal((await stat(responsePath)).size < 100_000, true);
});

test("Execute-style launch does not capture or return model output", async () => {
  const fake = fakeSpawn((child) => {
    child.output.end("model output must remain discarded");
    child.input.once("finish", () => child.close(0));
  });
  const performer = new CodexCliPerformer({ spawn: fake.spawn });
  const result = await performer.launch(request());
  assert.equal(result.launch_status, "exited");
  assert.equal(result.final_response_ref, undefined);
});

test("start failures preserve only the current direct error message", async () => {
  const directMessage = "spawn detail that is intentionally longer than fifty characters";
  const performer = new CodexCliPerformer({
    spawn: () => { throw new Error(directMessage, { cause: new Error("provider cause must remain private") }); },
  });
  const result = await performer.launch(request());
  assert.equal(result.launch_status, "start_failed");
  assert.equal(result.sanitized_reason, directMessage.slice(0, 50));
  assert.doesNotMatch(result.sanitized_reason!, /provider cause/u);
});

test("asynchronous process errors preserve their direct message", async () => {
  const directMessage = "child process error detail that is intentionally longer than fifty characters";
  const fake = fakeSpawn((child) => {
    queueMicrotask(() => {
      child.emit("error", new Error(directMessage, { cause: new Error("provider cause must remain private") }));
    });
  });
  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request());
  assert.equal(result.launch_status, "start_failed");
  assert.equal(result.sanitized_reason, directMessage.slice(0, 50));
  assert.doesNotMatch(result.sanitized_reason!, /provider cause/u);
});

test("stream errors preserve their direct message without exposing stream contents", async () => {
  const directMessage = "stream error detail that is intentionally longer than fifty characters";
  const fake = fakeSpawn((child) => {
    queueMicrotask(() => {
      child.errors.emit("error", new Error(directMessage, { cause: new Error("raw stderr cause") }));
      child.close(23);
    });
  });
  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request());
  assert.equal(result.launch_status, "exited");
  assert.equal(result.exit_code, 23);
  assert.equal(result.sanitized_reason, directMessage.slice(0, 50));
  assert.doesNotMatch(result.sanitized_reason!, /raw stderr cause/u);
});

test("timeout and caller cancellation map to distinct terminal process facts", async () => {
  const timedOutFake = fakeSpawn(() => undefined);
  const timedOut = await new CodexCliPerformer({
    spawn: timedOutFake.spawn,
    kill_grace_ms: 1,
  }).launch(request({ timeout_ms: 5 }));
  assert.equal(timedOut.launch_status, "timed_out");
  assert.equal(timedOut.sanitized_reason, "Process timed out after 5 ms");
  assert.equal(timedOutFake.calls.length, 1);

  const interruptedFake = fakeSpawn(() => undefined);
  const controller = new AbortController();
  const pending = new CodexCliPerformer({
    spawn: interruptedFake.spawn,
    kill_grace_ms: 1,
  }).launch(request(), controller.signal);
  controller.abort();
  const interrupted = await pending;
  assert.equal(interrupted.launch_status, "interrupted");
  assert.equal(interrupted.sanitized_reason, "Process interrupted");
});

test("stream overflow keeps its specific reason when the adapter interrupts the process", async () => {
  const fake = fakeSpawn((child) => {
    child.output.write("x".repeat(8));
    setImmediate(() => child.close(null, "SIGTERM"));
  });
  const result = await new CodexCliPerformer({
    spawn: fake.spawn,
    max_stream_bytes: 4,
    kill_grace_ms: 1,
  }).launch(request());

  assert.equal(result.launch_status, "interrupted");
  assert.equal(result.sanitized_reason, "Output exceeded 4 bytes");
});

test("nonzero exits remain process facts and do not become semantic results", async () => {
  const fake = fakeSpawn((child) => {
    child.input.once("finish", () => child.close(23));
  });
  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request());
  assert.equal(result.launch_status, "exited");
  assert.equal(result.exit_code, 23);
  assert.equal(result.sanitized_reason, "Process exited with code 23");
});

test("JSONL error messages remain direct and raw JSONL stays private", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-jsonl-error-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const jsonlPath = path.join(temporary, "error.jsonl");
  const directMessage = "JSONL error detail that is intentionally longer than fifty characters";
  const raw = `${JSON.stringify({
    type: "error",
    message: directMessage,
    cause: "raw provider context must remain private",
  })}\n`;
  const fake = fakeSpawn((child) => {
    child.output.end(raw);
    child.input.once("finish", () => child.close(23));
  });

  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request({
    diagnostic_jsonl_path: jsonlPath,
  }));

  assert.equal(result.sanitized_reason, directMessage.slice(0, 50));
  assert.equal(result.diagnostic_jsonl_ref, jsonlPath);
  assert.equal(await readFile(jsonlPath, "utf8"), raw);
  assert.doesNotMatch(result.sanitized_reason!, /raw provider context/u);
});

test("captures exact Codex JSONL and stderr, extracts process facts, and locks diagnostic files", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-diagnostics-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const jsonlPath = path.join(temporary, "execute.jsonl");
  const stderrPath = path.join(temporary, "execute.stderr");
  const jsonl = [
    '{"type":"thread.started","thread_id":"thread-123"}\n',
    '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n',
    '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":12,"cache_write_input_tokens":4,"output_tokens":25,"reasoning_output_tokens":9}}\n',
  ].join("");
  const stderr = "warning: retained exactly\n";
  const fake = fakeSpawn((child) => {
    child.output.write(jsonl.slice(0, 19));
    child.output.write(jsonl.slice(19));
    child.errors.end(stderr);
    child.input.once("finish", () => child.close(0));
  });
  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request({
    diagnostic_jsonl_path: jsonlPath,
    diagnostic_stderr_path: stderrPath,
  }));

  assert.equal(result.launch_status, "exited");
  assert.equal(result.thread_id, "thread-123");
  assert.deepEqual(result.token_usage, {
    input_tokens: 100,
    cached_input_tokens: 12,
    cache_write_input_tokens: 4,
    output_tokens: 25,
    reasoning_output_tokens: 9,
    total_tokens: 125,
  });
  assert.equal(result.diagnostic_jsonl_ref, jsonlPath);
  assert.equal(result.diagnostic_stderr_ref, stderrPath);
  assert.equal(await readFile(jsonlPath, "utf8"), jsonl);
  assert.equal(await readFile(stderrPath, "utf8"), stderr);
  assert.equal((await stat(jsonlPath)).mode & 0o777, 0o600);
  assert.equal((await stat(stderrPath)).mode & 0o777, 0o600);
  assert.equal(fake.calls[0]?.args.includes("--json"), true);
});

test("retains unknown and malformed JSONL while continuing mechanical thread extraction", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-diagnostics-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const jsonlPath = path.join(temporary, "audit.jsonl");
  const stderrPath = path.join(temporary, "audit.stderr");
  const jsonl = [
    '{"type":"unknown"}',
    "not-json",
    '{"type":"thread.started","thread_id":42}',
    `{"type":"thread.started","thread_id":"${"x".repeat(300)}"}`,
    '{"type":"thread.started","thread_id":"thread-after-malformed"}',
    "",
  ].join("\n");
  const fake = fakeSpawn((child) => {
    child.output.end(jsonl);
    child.input.once("finish", () => child.close(0));
  });
  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request({
    diagnostic_jsonl_path: jsonlPath,
    diagnostic_stderr_path: stderrPath,
  }));

  assert.equal(result.thread_id, "thread-after-malformed");
  assert.equal(result.token_usage, undefined);
  assert.equal(result.diagnostic_jsonl_ref, jsonlPath);
  assert.equal(result.diagnostic_stderr_ref, stderrPath);
  assert.equal(await readFile(jsonlPath, "utf8"), jsonl);
});

test("omits token usage when a terminal event lacks required counters", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-usage-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const jsonlPath = path.join(temporary, "usage.jsonl");
  const jsonl = [
    '{"type":"thread.started","thread_id":"thread-usage"}\n',
    '{"type":"turn.completed","usage":{"input_tokens":80,"output_tokens":20}}\n',
    '{"type":"turn.completed","usage":{"input_tokens":80,"output_tokens":"unknown"}}\n',
  ].join("");
  const fake = fakeSpawn((child) => {
    child.output.end(jsonl);
    child.input.once("finish", () => child.close(0));
  });

  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request({
    diagnostic_jsonl_path: jsonlPath,
  }));

  assert.equal(result.token_usage, undefined);
  assert.equal(await readFile(jsonlPath, "utf8"), jsonl);
});

test("keeps known usage counters and omits malformed optional counters", async () => {
  const fake = fakeSpawn((child) => {
    child.output.end(JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 3,
        cache_write_input_tokens: "not-a-count",
        reasoning_output_tokens: -1,
        provider_total_tokens: 999,
      },
    }) + "\n");
    child.input.once("finish", () => child.close(0));
  });

  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request());
  assert.deepEqual(result.token_usage, {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    cached_input_tokens: 3,
  });
});

test("keeps diagnostic references and bounded raw output for nonzero, timeout, and overflow outcomes", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-diagnostics-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));

  const nonzeroJsonl = path.join(temporary, "nonzero.jsonl");
  const nonzeroStderr = path.join(temporary, "nonzero.stderr");
  const nonzeroFake = fakeSpawn((child) => {
    child.output.end('{"type":"thread.started","thread_id":"thread-nonzero"}\n');
    child.errors.end("provider warning\n");
    child.input.once("finish", () => child.close(23));
  });
  const nonzero = await new CodexCliPerformer({ spawn: nonzeroFake.spawn }).launch(request({
    diagnostic_jsonl_path: nonzeroJsonl,
    diagnostic_stderr_path: nonzeroStderr,
  }));
  assert.equal(nonzero.launch_status, "exited");
  assert.equal(nonzero.exit_code, 23);
  assert.equal(nonzero.thread_id, "thread-nonzero");
  assert.equal(nonzero.diagnostic_jsonl_ref, nonzeroJsonl);
  assert.equal(await readFile(nonzeroStderr, "utf8"), "provider warning\n");

  const timeoutJsonl = path.join(temporary, "timeout.jsonl");
  const timeoutStderr = path.join(temporary, "timeout.stderr");
  const timeoutFake = fakeSpawn((child) => {
    child.output.write('{"type":"thread.started","thread_id":"thread-timeout"}\n');
  });
  const timeout = await new CodexCliPerformer({ spawn: timeoutFake.spawn, kill_grace_ms: 1 }).launch(request({
    timeout_ms: 5,
    diagnostic_jsonl_path: timeoutJsonl,
    diagnostic_stderr_path: timeoutStderr,
  }));
  assert.equal(timeout.launch_status, "timed_out");
  assert.equal(timeout.thread_id, "thread-timeout");
  assert.equal(await readFile(timeoutJsonl, "utf8"), '{"type":"thread.started","thread_id":"thread-timeout"}\n');

  const overflowJsonl = path.join(temporary, "overflow.jsonl");
  const overflowStderr = path.join(temporary, "overflow.stderr");
  const overflowFake = fakeSpawn((child) => {
    child.output.write("0123456789");
    setImmediate(() => child.close(null, "SIGTERM"));
  });
  const overflow = await new CodexCliPerformer({
    spawn: overflowFake.spawn,
    max_stream_bytes: 4,
    kill_grace_ms: 1,
  }).launch(request({
    diagnostic_jsonl_path: overflowJsonl,
    diagnostic_stderr_path: overflowStderr,
  }));
  assert.equal(overflow.launch_status, "interrupted");
  assert.equal(overflow.sanitized_reason, "Output exceeded 4 bytes");
  assert.equal(overflow.diagnostic_jsonl_ref, overflowJsonl);
  assert.equal((await stat(overflowJsonl)).size <= 4, true);
});

test("fails closed when a requested diagnostic artifact cannot be written", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-diagnostics-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const jsonlDirectory = path.join(temporary, "jsonl-directory");
  await mkdir(jsonlDirectory);
  const stderrPath = path.join(temporary, "stderr.log");
  const fake = fakeSpawn((child) => {
    child.output.end('{"type":"thread.started","thread_id":"thread-write-failure"}\n');
    child.errors.end("stderr retained\n");
    child.input.once("finish", () => child.close(0));
  });

  const result = await new CodexCliPerformer({ spawn: fake.spawn }).launch(request({
    diagnostic_jsonl_path: jsonlDirectory,
    diagnostic_stderr_path: stderrPath,
  }));

  assert.equal(result.launch_status, "exited");
  assert.equal(result.exit_code, 0);
  assert.equal(result.sanitized_reason, "Diagnostic capture failed");
  assert.equal(result.diagnostic_jsonl_ref, undefined);
  assert.equal(result.diagnostic_stderr_ref, stderrPath);
  assert.equal(result.thread_id, "thread-write-failure");
  assert.equal(await readFile(stderrPath, "utf8"), "stderr retained\n");
});

test("does not follow diagnostic file or parent symlinks", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-diagnostic-links-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-diagnostic-outside-"));
  context.after(async () => {
    await rm(temporary, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const secretPath = path.join(outside, "secret.log");
  await writeFile(secretPath, "keep-secret", { encoding: "utf8", mode: 0o600 });
  const linkedFile = path.join(temporary, "capture.jsonl");
  await symlink(secretPath, linkedFile, "file");

  const linkedFileResult = await new CodexCliPerformer({
    spawn: fakeSpawn((child) => {
      child.output.end('{"type":"thread.started","thread_id":"thread-link"}\n');
      child.input.once("finish", () => child.close(0));
    }).spawn,
  }).launch(request({ diagnostic_jsonl_path: linkedFile }));
  assert.equal(linkedFileResult.sanitized_reason, "Diagnostic capture failed");
  assert.equal(linkedFileResult.diagnostic_jsonl_ref, undefined);
  assert.equal(await readFile(secretPath, "utf8"), "keep-secret");

  const linkedDirectory = path.join(temporary, "linked-directory");
  await symlink(outside, linkedDirectory, "dir");
  const linkedParentResult = await new CodexCliPerformer({
    spawn: fakeSpawn((child) => {
      child.output.end("raw output\n");
      child.input.once("finish", () => child.close(0));
    }).spawn,
  }).launch(request({ diagnostic_jsonl_path: path.join(linkedDirectory, "capture.jsonl") }));
  assert.equal(linkedParentResult.sanitized_reason, "Diagnostic capture failed");
  assert.deepEqual(await readdir(outside), ["secret.log"]);
});

test("rejects diagnostic traversal and existing files without overwriting", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "symphony-performer-diagnostic-paths-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));

  const existing = path.join(temporary, "existing.jsonl");
  await writeFile(existing, "original", "utf8");
  const existingResult = await new CodexCliPerformer({
    spawn: fakeSpawn((child) => {
      child.output.end("replacement");
      child.input.once("finish", () => child.close(0));
    }).spawn,
  }).launch(request({ diagnostic_jsonl_path: existing }));
  assert.equal(existingResult.sanitized_reason, "Diagnostic capture failed");
  assert.equal(await readFile(existing, "utf8"), "original");

  const traversal = `${temporary}/nested/../traversal.jsonl`;
  const traversalResult = await new CodexCliPerformer({
    spawn: fakeSpawn((child) => {
      child.output.end("must not write");
      child.input.once("finish", () => child.close(0));
    }).spawn,
  }).launch(request({ diagnostic_jsonl_path: traversal }));
  assert.equal(traversalResult.sanitized_reason, "Diagnostic capture failed");
  assert.equal(await stat(path.join(temporary, "traversal.jsonl")).then(() => true, () => false), false);
});
