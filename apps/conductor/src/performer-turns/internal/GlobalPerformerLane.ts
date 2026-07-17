import { spawn, type ChildProcess } from "node:child_process";

export interface PerformerInvocation {
  executable: string;
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  deadlineMs: number;
  stdin?: Uint8Array;
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
    child.kill("SIGTERM");
    if (await waitForExit(child, graceMs)) return;
    child.kill("SIGKILL");
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
        stdio: [invocation.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      if (invocation.stdin && child.stdin) {
        child.stdin.end(invocation.stdin);
      }
      this.#active = child;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      if (!child.stdout || !child.stderr) {
        child.kill("SIGKILL");
        this.#active = undefined;
        reject(new Error("performer_process_stream_missing"));
        return;
      }
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      let forceKill: NodeJS.Timeout | undefined;
      let terminalTimeout: NodeJS.Timeout | undefined;
      let settled = false;
      const clearTimers = () => {
        clearTimeout(deadline);
        if (forceKill) clearTimeout(forceKill);
        if (terminalTimeout) clearTimeout(terminalTimeout);
      };
      const deadline = setTimeout(() => {
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          terminalTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            this.#stopping = true;
            reject(new Error("performer_process_reap_timeout"));
          }, 1000);
        }, 1000);
      }, invocation.deadlineMs);
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.#active = undefined;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimers();
        this.#active = undefined;
        if (settled) return;
        settled = true;
        const output = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        };
        if (code === 0) resolve(output);
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
