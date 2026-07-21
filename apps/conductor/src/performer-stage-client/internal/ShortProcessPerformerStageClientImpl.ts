import {
  decodeConductorPerformerStageContextEnvelope,
  decodeConductorPerformerStageEvent,
  decodeConductorPerformerStageResult,
  type JsonValue,
} from "@symphony/contracts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  PerformerStageClientInterface,
  PerformerStageClientRunInput,
  PerformerStageClientRunResult,
} from "../api/PerformerStageClientInterface.js";
import { stageProcessEnvironment } from "./StageProcessEnvironment.js";

type JsonRecord = { [key: string]: JsonValue };
interface StageEnvelope extends JsonRecord {
  execution_policy: { performer_profile_id: string };
  limits: {
    max_context_bytes: number;
    max_result_bytes: number;
    max_wall_time_ms: number;
  };
}
type StageCorrelation = Pick<
  JsonRecord,
  | "protocol_version"
  | "stage_execution_id"
  | "stage"
  | "root_issue_id"
  | "cycle_issue_id"
  | "node_issue_id"
  | "context_digest"
>;

const MAX_EVENT_BYTES = 1_048_576;
const MAX_STDERR_BYTES = 1_048_576;
const MAX_EVENT_FRAME_BYTES = 65_536;

export interface ShortProcessPerformerStageClientOptions {
  executable: string;
  argumentsPrefix?: string[];
  runtimeRoot: string;
  environment(profileId: string): NodeJS.ProcessEnv;
  codexBaseUrl?: string;
  startupDeadlineMs: number;
  cancellationGraceMs: number;
}

interface ActiveProcess {
  cancel(error: Error): void;
  done: Promise<void>;
}

export class ShortProcessPerformerStageClientImpl
  implements PerformerStageClientInterface {
  #active: ActiveProcess | undefined;
  #busy = false;
  #cancelRequested = false;

  constructor(private readonly options: ShortProcessPerformerStageClientOptions) {}

  async runStage(
    input: PerformerStageClientRunInput,
  ): Promise<PerformerStageClientRunResult> {
    if (this.#busy) throw new Error("performer_stage_client_busy");
    if (input.signal?.aborted) throw new Error("performer_stage_canceled");
    this.#busy = true;
    this.#cancelRequested = false;
    try {
      const envelope = decodeEnvelope(input.envelope);
      const correlation = envelopeCorrelation(envelope);
      await assertWorkspaceRoot(input.workspaceRoot);
      const requestBytes = Buffer.from(`${JSON.stringify(input.envelope)}\n`, "utf8");
      if (requestBytes.byteLength > envelope.limits.max_context_bytes) {
        throw new Error("performer_stage_context_bytes_exceeded");
      }

      await mkdir(this.options.runtimeRoot, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(path.join(this.options.runtimeRoot, "stage-"));
      const requestPath = path.join(directory, "request.json");
      const resultPath = path.join(directory, "result.json");
      try {
        await writeFile(requestPath, requestBytes, { encoding: "utf8", mode: 0o600 });
        if (this.#cancelRequested || input.signal?.aborted) {
          throw new Error("performer_stage_canceled");
        }
        await this.#runProcess({
          correlation,
          envelope,
          requestPath,
          resultPath,
          input,
        });
        return { result: await readCorrelatedResult(resultPath, envelope, correlation) };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      this.#busy = false;
      this.#cancelRequested = false;
    }
  }

  async cancelAndReap(): Promise<void> {
    const active = this.#active;
    if (!active) {
      if (this.#busy) this.#cancelRequested = true;
      return;
    }
    active.cancel(new Error("performer_stage_canceled"));
    await active.done.catch(() => undefined);
  }

  #runProcess(input: {
    correlation: StageCorrelation;
    envelope: StageEnvelope;
    requestPath: string;
    resultPath: string;
    input: PerformerStageClientRunInput;
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const arguments_ = [
        ...(this.options.argumentsPrefix ?? []),
        "--request", input.requestPath,
        "--result", input.resultPath,
        "--workspace-root", input.input.workspaceRoot,
      ];
      const environment = stageProcessEnvironment(
        this.options.executable,
        this.options.codexBaseUrl,
        this.options.environment(String(input.envelope.execution_policy.performer_profile_id)),
      );
      const child = spawn(this.options.executable, arguments_, {
        cwd: input.input.workspaceRoot,
        env: environment,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const decoder = new StageEventDecoder(input.correlation, input.input.onEvent);
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let terminalError: Error | undefined;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      const startupTimer = setTimeout(
        () => terminate(new Error("performer_stage_startup_timeout")),
        this.options.startupDeadlineMs,
      );
      let wallTimer: NodeJS.Timeout | undefined;
      let resolveDone!: () => void;
      const done = new Promise<void>((doneResolve) => { resolveDone = doneResolve; });

      const clearTimers = () => {
        if (startupTimer) clearTimeout(startupTimer);
        if (wallTimer) clearTimeout(wallTimer);
        if (killTimer) clearTimeout(killTimer);
      };
      const terminate = (error: Error) => {
        if (terminalError) return;
        terminalError = error;
        signalProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), this.options.cancellationGraceMs);
      };
      const failFromCallback = (error: unknown, fallback: string) => {
        terminate(error instanceof Error ? error : new Error(fallback));
      };
      const active: ActiveProcess = { cancel: terminate, done };
      this.#active = active;

      const onAbort = () => terminate(new Error("performer_stage_canceled"));
      input.input.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("spawn", () => {
        if (startupTimer) clearTimeout(startupTimer);
        wallTimer = setTimeout(
          () => terminate(new Error("performer_stage_timeout")),
          input.envelope.limits.max_wall_time_ms,
        );
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          decoder.write(chunk);
        } catch (error) {
          failFromCallback(error, "performer_stage_event_invalid");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) {
          terminate(new Error("performer_stderr_bytes_exceeded"));
        } else {
          stderr.push(chunk);
        }
      });
      child.once("error", (error) => terminate(error));
      child.once("close", (code, signal) => {
        clearTimers();
        input.input.signal?.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        try {
          if (!terminalError) decoder.end();
          if (terminalError) reject(terminalError);
          else if (code !== 0) {
            reject(new Error(
              `performer_stage_process_failed exit_code=${code ?? "none"} signal=${signal ?? "none"} sanitized_reason=${sanitize(Buffer.concat(stderr).toString("utf8"))}`,
            ));
          } else resolve();
        } catch (error) {
          reject(error);
        } finally {
          resolveDone();
        }
      });
    }).finally(() => {
      this.#active = undefined;
    });
  }
}

function decodeEnvelope(value: JsonValue): StageEnvelope {
  try {
    return decodeConductorPerformerStageContextEnvelope(value) as unknown as StageEnvelope;
  } catch {
    throw new Error("performer_stage_context_invalid");
  }
}

function envelopeCorrelation(envelope: JsonRecord): StageCorrelation {
  const execution = envelope.stage_execution as JsonRecord;
  const target = envelope.target as JsonRecord;
  return {
    protocol_version: envelope.protocol_version!,
    stage_execution_id: execution.stage_execution_id!,
    stage: execution.stage!,
    root_issue_id: target.root_issue_id!,
    cycle_issue_id: target.cycle_issue_id!,
    node_issue_id: target.node_issue_id!,
    context_digest: envelope.context_digest!,
  };
}

async function readCorrelatedResult(
  resultPath: string,
  envelope: StageEnvelope,
  expected: StageCorrelation,
): Promise<JsonValue> {
  let bytes: Buffer;
  try {
    bytes = await readFile(resultPath);
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("performer_stage_result_missing");
    }
    throw new Error("performer_stage_result_read_failed");
  }
  if (bytes.byteLength > envelope.limits.max_result_bytes) {
    throw new Error("performer_stage_result_bytes_exceeded");
  }
  let value: JsonValue;
  try {
    value = JSON.parse(bytes.toString("utf8")) as JsonValue;
    value = decodeConductorPerformerStageResult(value) as unknown as JsonValue;
  } catch {
    throw new Error("performer_stage_result_invalid");
  }
  const result = value as unknown as JsonRecord;
  for (const field of correlationFields) {
    if (result[field] !== expected[field]) {
      throw new Error("performer_stage_result_correlation_invalid");
    }
  }
  return value;
}

const correlationFields = [
  "protocol_version", "stage_execution_id", "stage", "root_issue_id",
  "cycle_issue_id", "node_issue_id", "context_digest",
] as const;

class StageEventDecoder {
  #buffer = Buffer.alloc(0);
  #bytes = 0;
  #nextSequence = 0;
  #stopped = false;

  constructor(
    private readonly expected: StageCorrelation,
    private readonly onEvent?: (event: Readonly<Record<string, JsonValue>>) => void,
  ) {}

  write(chunk: Uint8Array): void {
    if (this.#stopped) return;
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_EVENT_BYTES) {
      this.#stopped = true;
      throw new Error("performer_stage_event_bytes_exceeded");
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    if (this.#buffer.byteLength > MAX_EVENT_FRAME_BYTES
      && this.#buffer.indexOf(0x0a) < 0) {
      this.#stopped = true;
      throw new Error("performer_stage_event_frame_exceeded");
    }
    let newline: number;
    while ((newline = this.#buffer.indexOf(0x0a)) >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (frame.byteLength > MAX_EVENT_FRAME_BYTES) {
        this.#stopped = true;
        throw new Error("performer_stage_event_frame_exceeded");
      }
      this.#decode(frame);
    }
  }

  end(): void {
    if (this.#buffer.byteLength > 0) {
      throw new Error("performer_stage_event_frame_incomplete");
    }
  }

  #decode(frame: Uint8Array): void {
    let event: JsonRecord;
    try {
      event = decodeConductorPerformerStageEvent(
        JSON.parse(Buffer.from(frame).toString("utf8")) as JsonValue,
      ) as unknown as JsonRecord;
    } catch {
      throw new Error("performer_stage_event_contract_invalid");
    }
    if (correlationFields.some((field) => event[field] !== this.expected[field])
      || event.sequence !== this.#nextSequence) {
      throw new Error("performer_stage_event_correlation_invalid");
    }
    this.#nextSequence += 1;
    this.onEvent?.(event);
  }
}

async function assertWorkspaceRoot(workspaceRoot: string): Promise<void> {
  if (!workspaceRoot || workspaceRoot.includes("\0") || !path.isAbsolute(workspaceRoot)) {
    throw new Error("performer_workspace_invalid");
  }
  try {
    if (!(await stat(workspaceRoot)).isDirectory()) throw new Error("performer_workspace_invalid");
  } catch (error) {
    if (error instanceof Error && error.message === "performer_workspace_invalid") throw error;
    throw new Error("performer_workspace_invalid");
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
  }
}

function sanitize(value: string): string {
  return value
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2048);
}
