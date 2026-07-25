import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const CLONE_COUNT = 3;

export async function provisionParallelE2ERepositories({ sourceRepositoryRoot }) {
  if (typeof sourceRepositoryRoot !== "string" || sourceRepositoryRoot.length === 0) {
    throw stableError("parallel_e2e_repository_source_invalid");
  }
  const sourceRoot = await canonicalGitRoot(sourceRepositoryRoot);
  const baseBranch = await git(["-C", sourceRoot, "branch", "--show-current"]);
  if (!BRANCH.test(baseBranch)) throw stableError("parallel_e2e_repository_branch_invalid");
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "symphony-e2e-repositories-"));
  try {
    const repositories = await Promise.all(
      Array.from({ length: CLONE_COUNT }, (_, index) => cloneRepository({
        sourceRoot,
        baseBranch,
        destination: path.join(temporaryDirectory, `repository-${index + 1}`),
        index,
      })),
    );
    let closed = false;
    return Object.freeze({
      repositories: Object.freeze(repositories),
      async close() {
        if (closed) return;
        closed = true;
        await rm(temporaryDirectory, { force: true, recursive: true });
      },
    });
  } catch (error) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw error;
  }
}

async function cloneRepository({ sourceRoot, baseBranch, destination, index }) {
  await git(["clone", "--local", "--no-hardlinks", "--branch", baseBranch, sourceRoot, destination]);
  const repositoryRoot = await canonicalGitRoot(destination);
  const commonDirectory = await realpath(await git([
    "-C", repositoryRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]));
  const identity = createHash("sha256").update(commonDirectory).digest("hex");
  return Object.freeze({
    repository_handle: identity,
    repository_identity: identity,
    repository_display_name: `Parallel E2E Repository ${index + 1}`,
    repository_root: repositoryRoot,
    base_branch: baseBranch,
  });
}

async function canonicalGitRoot(repositoryRoot) {
  let expectedRoot;
  try {
    expectedRoot = await realpath(repositoryRoot);
  } catch {
    throw stableError("parallel_e2e_repository_source_invalid");
  }
  const topLevel = await git(["-C", expectedRoot, "rev-parse", "--show-toplevel"]);
  let gitRoot;
  try {
    gitRoot = await realpath(topLevel);
  } catch {
    throw stableError("parallel_e2e_repository_source_invalid");
  }
  if (gitRoot !== expectedRoot) throw stableError("parallel_e2e_repository_source_invalid");
  return gitRoot;
}

async function git(arguments_) {
  try {
    const { stdout } = await execFile("git", arguments_, { maxBuffer: 1_048_576 });
    return stdout.trim();
  } catch {
    throw stableError("parallel_e2e_repository_git_failed");
  }
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
