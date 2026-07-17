import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  loadDotEnvFile,
  loadE2EConfig,
  summarizeConfig,
} from "./config.mjs";

const config = loadE2EConfig({ dotenv: loadDotEnvFile() });
const repository = inspectRepository(config.repository.path);
if (!repository.remote.includes(config.github.repository)) throw failure("repository_remote_not_allowlisted");
if (!repository.branches.includes(config.github.baseBranch)) throw failure("repository_base_branch_missing");

process.stdout.write(JSON.stringify({
  status: "ready",
  config: summarizeConfig(config),
  repository: {
    remote: repository.remote,
    baseBranch: config.github.baseBranch,
  },
  tools: {
    node: process.version,
    git: version("git", ["--version"]),
    npm: version("npm", ["--version"]),
    python: version(".venv/bin/python", ["--version"]),
    rustc: version("rustc", ["--version"]),
    gh: version("gh", ["--version"]),
  },
}, null, 2) + "\n");

function inspectRepository(repositoryPath) {
  try {
    const remote = execFileSync("git", ["-C", repositoryPath, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const branches = execFileSync("git", ["-C", repositoryPath, "for-each-ref", "--format=%(refname:short)", "refs/heads/"], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
    return { remote, branches };
  } catch {
    throw failure("repository_inspection_failed");
  }
}

function version(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
  } catch {
    return "unavailable";
  }
}

function failure(reason) {
  const error = new Error(reason);
  error.code = reason;
  return error;
}
