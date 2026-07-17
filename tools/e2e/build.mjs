import { spawnSync } from "node:child_process";

const workspaceBuild = spawnSync("npm", ["run", "build", "--workspaces", "--if-present"], {
  cwd: process.cwd(),
  stdio: "inherit",
});
if (workspaceBuild.status !== 0) throw new Error("e2e_build_failed");
const desktopBuild = spawnSync(
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
    "--features",
    "e2e",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, SYMPHONY_E2E_BUILD: "1" },
    stdio: "inherit",
  },
);
if (desktopBuild.status !== 0) throw new Error("e2e_desktop_build_failed");
process.stdout.write("E2E build artifacts are ready; packaged mutation remains opt-in.\n");
