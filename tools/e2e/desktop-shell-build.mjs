import { spawnSync } from "node:child_process";

import { createDesktopShellEnvironment } from "./desktop-shell-environment.mjs";

const environment = createDesktopShellEnvironment();
run(
  "npm",
  [
    "run",
    "tauri",
    "--workspace",
    "@symphony/podium-desktop",
    "--",
    "build",
    "--debug",
    "--no-bundle",
  ],
  "desktop_shell_native_build_failed",
);
process.stdout.write("Desktop shell smoke artifacts are ready.\n");

function run(executable, arguments_, code) {
  const command = process.platform === "win32" && executable === "npm"
    ? "npm.cmd"
    : executable;
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) throw new Error(code);
}
