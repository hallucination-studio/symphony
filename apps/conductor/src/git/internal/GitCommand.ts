import { spawn } from "node:child_process";

export interface GitCommandOptions {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export class GitCommand {
  constructor(private readonly options: GitCommandOptions) {}

  run(cwd: string, args: readonly string[], acceptedExitCodes: readonly number[] = [0]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.options.executable, ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const fail = (code: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(code));
      };
      const timer = setTimeout(() => fail("git_command_timed_out"), this.options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.options.maxOutputBytes) fail("git_command_output_too_large");
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.options.maxOutputBytes) fail("git_command_output_too_large");
      });
      child.once("error", () => fail("git_command_unavailable"));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === null || !acceptedExitCodes.includes(code)) reject(new Error("git_command_failed"));
        else resolve(Buffer.concat(stdout));
      });
    });
  }
}
