import { spawnSync } from "node:child_process";

import { createChildEnvironment, loadE2EConfig } from "./config.mjs";
import { runCoreLiveE2E } from "./core-live-runner.mjs";

const BUILD_WORKSPACES = Object.freeze([
  "@symphony/podium",
  "@symphony/conductor",
]);

const arguments_ = process.argv.slice(2);
if (arguments_.length === 1 && arguments_[0] === "--dry-run") {
  const result = spawnSync(process.execPath, ["tools/e2e/core-live-runner.mjs", "--dry-run"], {
    encoding: "utf8",
    env: createChildEnvironment(),
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else if (arguments_.length !== 0) {
  process.stderr.write('{"status":"failed","reason":"e2e_argument_invalid"}\n');
  process.exitCode = 2;
} else {
  try {
    loadE2EConfig();
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    for (const workspace of BUILD_WORKSPACES) {
      const build = spawnSync(npm, ["run", "build", "-w", workspace], {
        encoding: "utf8",
        env: createChildEnvironment(),
      });
      if (build.error || build.status !== 0) throw stableError("e2e_build_failed");
    }
    const result = await runCoreLiveE2E();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", reason: sanitize(error) })}\n`);
    process.exitCode = 2;
  }
}

function sanitize(error) {
  const code = error?.code ?? error?.message;
  return typeof code === "string" && /^[a-z][a-z0-9_]{1,120}$/u.test(code)
    ? code
    : "e2e_core_live_failed";
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
