import { spawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";

export interface PerformerInvocationControl {
  writeStdin(value: Uint8Array): void;
  closeStdin(): void;
  extraStreams: Duplex[];
  markReady?(): void;
}

export interface PerformerInvocation {
  executable: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  deadlineMs: number;
  startupDeadlineMs?: number;
  stdin?: Uint8Array;
  extraPipeCount?: number;
  onStarted?(control: PerformerInvocationControl): void;
  onStdout?(chunk: Uint8Array): void;
  maxOutputBytes?: number;
}

export class GlobalPerformerLane {
  #tail: Promise<void> = Promise.resolve();
  #active: ChildProcess | undefined;
  #stopping = false;

  run(invocation: PerformerInvocation) {
    const operation = this.#tail.then(() => {
      if (this.#stopping) throw new Error("performer_lane_stopped");
      return this.#invoke(invocation);
    });
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async cancelAndReap(graceMs: number) {
    this.#stopping = true;
    const child = this.#active;
    if (!child) return;
    signalProcessTree(child, "SIGTERM");
    if (await waitForExit(child, graceMs)) return;
    signalProcessTree(child, "SIGKILL");
    if (!(await waitForExit(child, graceMs))) {
      throw new Error("performer_process_reap_timeout");
    }
  }

  #invoke(invocation: PerformerInvocation): Promise<{
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.arguments, {
        cwd: invocation.workingDirectory,
        env: invocation.environment,
        detached: process.platform !== "win32",
        stdio: [
          invocation.stdin || invocation.onStarted ? "pipe" : "ignore",
          "pipe",
          "pipe",
          ...Array.from({ length: invocation.extraPipeCount ?? 0 }, () => "pipe" as const),
        ],
      });
      if (invocation.stdin && child.stdin) {
        child.stdin.end(invocation.stdin);
      }
      this.#active = child;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const maxOutputBytes = invocation.maxOutputBytes ?? 1_048_576;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let outputError: Error | undefined;
      if (!child.stdout || !child.stderr) {
        signalProcessTree(child, "SIGKILL");
        this.#active = undefined;
        reject(new Error("performer_process_stream_missing"));
        return;
      }
      let forceKill: NodeJS.Timeout | undefined;
      let terminalTimeout: NodeJS.Timeout | undefined;
      let settled = false;
      let terminationStarted = false;
      let deadline: NodeJS.Timeout | undefined;
      const expire = () => {
        if (terminationStarted) return;
        terminationStarted = true;
        if (deadline) clearTimeout(deadline);
        signalProcessTree(child, "SIGTERM");
        forceKill = setTimeout(() => {
          if (child.exitCode === null) signalProcessTree(child, "SIGKILL");
          terminalTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            this.#stopping = true;
            reject(new Error("performer_process_reap_timeout"));
          }, 1000);
        }, 1000);
      };
      if (invocation.onStarted) {
        const extraStreams = child.stdio.slice(3).filter(
          (stream): stream is Duplex => stream !== null,
        );
        invocation.onStarted({
          writeStdin(value) {
            if (!child.stdin?.writable) throw new Error("performer_stdin_closed");
            child.stdin.write(value);
          },
          closeStdin() { child.stdin?.end(); },
          extraStreams,
          markReady() {
            if (deadline) clearTimeout(deadline);
            deadline = setTimeout(expire, invocation.deadlineMs);
          },
        });
      }
      child.stdout.on("data", (chunk: Buffer) => {
        if (invocation.onStdout) invocation.onStdout(chunk);
        else {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > maxOutputBytes) {
            if (!outputError) {
              outputError = new Error("performer_stdout_bytes_exceeded");
              expire();
            }
          } else stdout.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > maxOutputBytes) {
          if (!outputError) {
            outputError = new Error("performer_stderr_bytes_exceeded");
            expire();
          }
        } else stderr.push(chunk);
      });
      const clearTimers = () => {
        if (deadline) clearTimeout(deadline);
        if (forceKill) clearTimeout(forceKill);
        if (terminalTimeout) clearTimeout(terminalTimeout);
      };
      deadline = setTimeout(
        expire,
        invocation.startupDeadlineMs ?? invocation.deadlineMs,
      );
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.#active = undefined;
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimers();
        this.#active = undefined;
        if (settled) return;
        settled = true;
        const output = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (outputError) reject(outputError);
        else if (code === 0) resolve(output);
        else {
          reject(
            new Error(
              `performer_process_failed exit_code=${code ?? "none"} signal=${signal ?? "none"} sanitized_reason=${sanitize(output.stderr)}`,
            ),
          );
        }
      });
    });
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

function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null) return Promise.resolve(true);
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

function sanitize(value: string) {
  return value
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2048);
}
