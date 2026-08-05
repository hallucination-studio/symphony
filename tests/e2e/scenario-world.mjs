import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error("scenario_path_invalid");
  }
  return value;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function runGit(workspace, args) {
  try {
    const result = await execute("git", [
      "-C", workspace,
      "-c", "user.name=Symphony E2E",
      "-c", "user.email=symphony-e2e@localhost",
      ...args,
    ], { encoding: "utf8", maxBuffer: 64 * 1024 });
    return result.stdout.trim();
  } catch {
    throw new Error("scenario_git_failed");
  }
}

export class ScenarioWorld {
  #removed = false;

  constructor({ base, workspace, runDirectory, remote, rootId, rootBranch }) {
    this.base = base;
    this.workspace = workspace;
    this.runDirectory = runDirectory;
    this.remote = remote;
    this.rootId = rootId;
    this.rootBranch = rootBranch;
  }

  async git(args) {
    if (this.#removed) throw new Error("scenario_world_removed");
    return runGit(this.workspace, args);
  }

  async write(relativePath, contents) {
    if (this.#removed) throw new Error("scenario_world_removed");
    const resolved = path.resolve(this.workspace, safeRelativePath(relativePath));
    if (!inside(this.workspace, resolved)) throw new Error("scenario_path_outside_workspace");
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, contents, { encoding: "utf8", mode: 0o600 });
    return resolved;
  }

  async read(relativePath) {
    if (this.#removed) throw new Error("scenario_world_removed");
    const resolved = path.resolve(this.workspace, safeRelativePath(relativePath));
    if (!inside(this.workspace, resolved)) throw new Error("scenario_path_outside_workspace");
    return readFile(resolved, "utf8");
  }

  async writeRunFile(relativePath, contents) {
    if (this.#removed) throw new Error("scenario_world_removed");
    const safePath = safeRelativePath(relativePath);
    const resolved = path.resolve(this.runDirectory, safePath);
    if (!inside(this.runDirectory, resolved)) throw new Error("scenario_path_outside_run_directory");
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, contents, { encoding: "utf8", mode: 0o600 });
    return resolved;
  }

  async status() {
    return this.git(["status", "--porcelain=v1", "--untracked-files=all"]);
  }

  async commit(message = "scenario change") {
    await this.git(["add", "--all"]);
    return this.git(["commit", "-m", message]);
  }

  async push() {
    return this.git(["push", "--set-upstream", "origin", this.rootBranch]);
  }

  async remoteHas(pathspec) {
    const result = await execute("git", ["--git-dir", this.remote, "show", `${this.rootBranch}:${pathspec}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    }).catch(() => { throw new Error("scenario_remote_missing"); });
    return result.stdout;
  }

  async cleanup() {
    if (this.#removed) return;
    this.#removed = true;
    await rm(this.base, { recursive: true, force: true });
  }
}

export async function createScenarioWorld({
  rootId = "root-1",
  rootBranch = "root/ENG-1",
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-world-"));
  const workspace = path.join(base, "workspace");
  const runDirectory = path.join(base, "run-evidence");
  const remote = path.join(base, "remote.git");
  try {
    await Promise.all([mkdir(workspace), mkdir(runDirectory)]);
    await execute("git", ["init", "--bare", remote], { encoding: "utf8" });
    await execute("git", ["init", "-b", rootBranch, workspace], { encoding: "utf8" });
    await runGit(workspace, ["remote", "add", "origin", remote]);
    await writeFile(path.join(workspace, "README.md"), "Root workspace\n", { encoding: "utf8", mode: 0o600 });
    await runGit(workspace, ["add", "README.md"]);
    await runGit(workspace, ["commit", "-m", "initial root"]);
    return new ScenarioWorld({
      base: await realpath(base),
      workspace: await realpath(workspace),
      runDirectory: await realpath(runDirectory),
      remote: await realpath(remote),
      rootId,
      rootBranch,
    });
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error instanceof Error && error.message.startsWith("scenario_")
      ? error
      : new Error("scenario_world_setup_failed");
  }
}
