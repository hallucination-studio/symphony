import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(desktopRoot, "../..");
const target = process.env.TAURI_ENV_TARGET_TRIPLE ?? rustTarget();
const binaries = path.join(desktopRoot, "src-tauri", "binaries");

await mkdir(binaries, { recursive: true });
buildWorkspaceDependencies();
compile(
  path.join(desktopRoot, "src-backend", "main.ts"),
  path.join(binaries, `podium-backend-${target}`),
);
compile(
  path.join(workspaceRoot, "apps", "conductor", "src", "main.ts"),
  path.join(binaries, `conductor-${target}`),
);
buildPythonSidecar(
  path.join(binaries, `performer-${target}`),
  path.join(workspaceRoot, "apps", "performer", "src", "performer", "__main__.py"),
  "performer-sidecar",
);
buildPythonSidecar(
  path.join(binaries, `symphony-${target}`),
  path.join(
    workspaceRoot, "apps", "performer", "src", "performer", "command_broker", "cli.py",
  ),
  "command-broker-sidecar",
);

function buildWorkspaceDependencies() {
  const result = spawnSync(
    "npm",
    [
      "run",
      "build",
      "--workspace",
      "@symphony/podium",
    ],
    { cwd: workspaceRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("sidecar_workspace_build_failed");
  }
}

function compile(entrypoint, output) {
  const result = spawnSync(
    process.env.BUN_EXECUTABLE ?? "bun",
    ["build", entrypoint, "--compile", "--outfile", output],
    { cwd: workspaceRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`sidecar_build_failed:${path.basename(output)}`);
  }
}

function buildPythonSidecar(output, entrypoint, workName) {
  const pyinstaller = path.join(
    workspaceRoot,
    ".venv",
    "bin",
    process.platform === "win32" ? "pyinstaller.exe" : "pyinstaller",
  );
  const work = path.join(workspaceRoot, "tmp", workName);
  const result = spawnSync(
    pyinstaller,
    [
      "--onefile",
      "--noconfirm",
      "--name",
      path.basename(output),
      "--distpath",
      binaries,
      "--workpath",
      work,
      "--specpath",
      work,
      entrypoint,
    ],
    { cwd: workspaceRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`python_sidecar_build_failed:${path.basename(output)}`);
  }
}

function rustTarget() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("rust_target_detection_failed");
  const host = result.stdout
    .split("\n")
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length);
  if (!host) throw new Error("rust_target_detection_failed");
  return host;
}
