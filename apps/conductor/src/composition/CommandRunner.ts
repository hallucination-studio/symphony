import { spawn } from "node:child_process";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCommand(
  executable: string,
  arguments_: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; deadlineMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    let forceKill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000);
    }, options.deadlineMs ?? 30_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? (signal ? 128 : 1),
      };
      if (result.exitCode === 0) resolve(result);
      else {
        reject(
          new Error(
            `command_failed executable=${executable} exit_code=${result.exitCode} sanitized_reason=${sanitize(result.stderr)}`,
          ),
        );
      }
    });
  });
}

function sanitize(value: string) {
  return value
    .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2048);
}
