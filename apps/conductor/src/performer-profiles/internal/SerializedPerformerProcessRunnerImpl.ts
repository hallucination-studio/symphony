import { spawn, type ChildProcess } from "node:child_process";

export interface SerializedPerformerProcessRunnerInterface {
  run(input: {
    executable: string;
    arguments: string[];
    environment: NodeJS.ProcessEnv;
    deadlineMs: number;
    stdin?: Uint8Array;
  }): Promise<{ stdout: string; stderr: string }>;
  cancelAndReap(graceMs: number): Promise<void>;
}

export class SerializedPerformerProcessRunnerImpl
  implements SerializedPerformerProcessRunnerInterface {
  #tail: Promise<void> = Promise.resolve();
  #active: ChildProcess | undefined;
  #stopping = false;

  run(input: Parameters<SerializedPerformerProcessRunnerInterface["run"]>[0]) {
    const operation = this.#tail.then(() => {
      if (this.#stopping) throw new Error("performer_process_runner_stopped");
      return this.#invoke(input);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async cancelAndReap(graceMs: number) {
    this.#stopping = true;
    const child = this.#active;
    if (!child) return;
    signalProcessTree(child, "SIGTERM");
    if (await waitForExit(child, graceMs)) return;
    signalProcessTree(child, "SIGKILL");
    if (!(await waitForExit(child, graceMs))) throw new Error("performer_process_reap_timeout");
  }

  #invoke(input: Parameters<SerializedPerformerProcessRunnerInterface["run"]>[0]) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(input.executable, input.arguments, {
        env: input.environment,
        stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      this.#active = child;
      if (input.stdin && child.stdin) child.stdin.end(input.stdin);
      if (!child.stdout || !child.stderr) {
        signalProcessTree(child, "SIGKILL");
        this.#active = undefined;
        reject(new Error("performer_process_stream_missing"));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.#active = undefined;
        callback();
      };
      const expire = () => {
        signalProcessTree(child, "SIGTERM");
        setTimeout(() => signalProcessTree(child, "SIGKILL"), 1_000);
      };
      const timeout = setTimeout(expire, input.deadlineMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 1_048_576) expire();
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > 1_048_576) expire();
        else stderr.push(chunk);
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code, signal) => finish(() => {
        if (code === 0) {
          resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        } else {
          reject(new Error(`performer_process_failed exit_code=${code ?? "none"} signal=${signal ?? "none"}`));
        }
      }));
    });
  }
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ESRCH")) throw error;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => { clearTimeout(timeout); resolve(true); };
    const timeout = setTimeout(() => { child.off("exit", onExit); resolve(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}
