import { spawn, type ChildProcess } from "node:child_process";
import type { JsonValue } from "@symphony/contracts";

export interface PerformerAgentChannelRequest {
  requestId: string;
  body: Record<string, unknown>;
  deadlineMs: number;
}

export interface PerformerAgentChannel {
  request(input: PerformerAgentChannelRequest): Promise<JsonValue>;
  close(graceMs: number): Promise<void>;
}

export interface PerformerAgentChannelFactory {
  open(input: {
    executable: string;
    environment: NodeJS.ProcessEnv;
  }): PerformerAgentChannel;
}

export class PerformerAgentChannelError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "PerformerAgentChannelError";
  }
}

type PendingResponse = {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 1 * 1024 * 1024;

export class PersistentPerformerAgentChannelFactory implements PerformerAgentChannelFactory {
  constructor(private readonly agentArguments: readonly string[] = ["--agent"]) {}

  open(input: { executable: string; environment: NodeJS.ProcessEnv }): PerformerAgentChannel {
    return new PersistentPerformerAgentChannel(input, this.agentArguments);
  }
}

class PersistentPerformerAgentChannel implements PerformerAgentChannel {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, PendingResponse>();
  private stdoutBuffer = "";
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private fatalError: Error | undefined;
  private closing = false;
  private closeOperation: Promise<void> | undefined;

  constructor(input: { executable: string; environment: NodeJS.ProcessEnv }, agentArguments: readonly string[]) {
    this.child = spawn(input.executable, agentArguments, {
      env: input.environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", () => {
      if ((!this.closing || this.pending.size > 0) && !this.fatalError) {
        this.fail(new Error("performer_agent_process_exited"));
      }
    });
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) {
      this.fail(new PerformerAgentChannelError("performer_agent_process_stream_missing"));
      return;
    }
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
  }

  request(input: PerformerAgentChannelRequest): Promise<JsonValue> {
    const operation = this.queue.then(() => this.send(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(graceMs: number): Promise<void> {
    this.closeOperation ??= this.reap(graceMs);
    return this.closeOperation;
  }

  private async reap(graceMs: number): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.closing = true;
    this.child.stdin?.end();
    if (await waitForExit(this.child, graceMs)) return;
    signalProcessTree(this.child, "SIGTERM");
    if (await waitForExit(this.child, graceMs)) return;
    signalProcessTree(this.child, "SIGKILL");
    if (!(await waitForExit(this.child, graceMs))) throw new Error("performer_agent_process_reap_timeout");
  }

  private send(input: PerformerAgentChannelRequest): Promise<JsonValue> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.closing) return Promise.reject(new Error("performer_agent_channel_closed"));
    const stdin = this.child.stdin;
    if (!stdin) return Promise.reject(new PerformerAgentChannelError("performer_agent_stdin_missing"));
    return new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(new Error("performer_agent_request_timeout"));
      }, input.deadlineMs);
      this.pending.set(input.requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        stdin.write(`${JSON.stringify(input.body)}\n`, (error) => {
          if (!error) return;
          this.fail(error);
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("performer_agent_write_failed"));
      }
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.fail(new Error("performer_agent_stdout_limit_exceeded"));
      return;
    }
    this.stdoutBuffer += chunk.toString("utf8");
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.onResponseLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBytes += chunk.byteLength;
    if (this.stderrBytes > MAX_STDERR_BYTES) this.fail(new Error("performer_agent_stderr_limit_exceeded"));
  }

  private onResponseLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.fail(new Error("performer_agent_response_invalid"));
      return;
    }
    if (!isJsonRecord(value) || typeof value.request_id !== "string") {
      this.fail(new Error("performer_agent_response_correlation_invalid"));
      return;
    }
    const request = this.pending.get(value.request_id);
    if (!request) {
      this.fail(new Error("performer_agent_response_unexpected"));
      return;
    }
    this.pending.delete(value.request_id);
    request.resolve(value);
  }

  private fail(error: Error): void {
    if (this.fatalError) return;
    const channelError = error instanceof PerformerAgentChannelError
      ? error
      : new PerformerAgentChannelError(error.message);
    this.fatalError = channelError;
    for (const request of this.pending.values()) request.reject(channelError);
    this.pending.clear();
    signalProcessTree(this.child, "SIGTERM");
    void this.close(1_000).catch(() => undefined);
  }
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
