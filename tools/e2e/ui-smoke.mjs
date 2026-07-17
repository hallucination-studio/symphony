import { spawnSync } from "node:child_process";

if (process.env.SYMPHONY_E2E_RUN_UI !== "1") {
  // Packaged mutation remains opt-in and never activates from production defaults.
  process.stdout.write(JSON.stringify({
    status: "blocked",
    reason: "set_SYMPHONY_E2E_RUN_UI_to_1_for_packaged_mutation",
  }) + "\n");
  process.exitCode = 2;
} else {
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wdio", "run", "wdio.conf.mjs"],
    { cwd: process.cwd(), stdio: "inherit" },
  );
  if (result.error) throw new Error("e2e_ui_smoke_start_failed");
  process.exitCode = result.status ?? 1;
}
