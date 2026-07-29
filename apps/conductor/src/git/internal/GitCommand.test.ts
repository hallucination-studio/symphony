import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { GitCommand } from "./GitCommand.js";

function command(executable: string, timeoutMs = 10_000, maxOutputBytes = 1_024): GitCommand {
  return new GitCommand({ executable, timeoutMs, maxOutputBytes });
}

async function executable(context: TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "symphony-git-command-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "command");
  await writeFile(target, `#!${process.execPath}\n${source}\n`, "utf8");
  await chmod(target, 0o700);
  return target;
}

test("run rejects unavailable commands without exposing the executable", async () => {
  const executable = "/missing/symphony-secret-git";

  await assert.rejects(command(executable).run(process.cwd(), ["status"]), (error: Error) => {
    assert.equal(error.message, "git_command_unavailable");
    assert.equal(error.message.includes(executable), false);
    return true;
  });
});

test("run bounds command duration", async (context) => {
  const target = await executable(context, "setTimeout(() => {}, 10_000);");
  await assert.rejects(
    command(target, 10).run(process.cwd(), ["status"]),
    /git_command_timed_out/u,
  );
});

test("run bounds combined stdout and stderr without returning their contents", async (context) => {
  const secret = "sensitive-command-output";
  const target = await executable(context, `
    process.stdout.write("${secret}" + "x".repeat(1024 * 1024));
  `);

  await assert.rejects(
    command(target).run(process.cwd(), ["status"]),
    (error: Error) => {
      assert.equal(error.message, "git_command_output_too_large");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("run sanitizes non-zero command failures", async (context) => {
  const secret = "sensitive-command-error";
  const target = await executable(context, `process.stderr.write("${secret}"); process.exit(7);`);

  await assert.rejects(
    command(target).run(process.cwd(), ["status"]),
    (error: Error) => {
      assert.equal(error.message, "git_command_failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
