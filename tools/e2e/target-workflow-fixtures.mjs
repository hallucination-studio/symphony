import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SCOPE_MARKER = ".symphony-target-run";

export async function createTargetRunScope({ runId, parentDirectory = os.tmpdir() } = {}) {
  validateRunId(runId, "target_run_scope_id_invalid");
  if (typeof parentDirectory !== "string" || parentDirectory.length === 0) {
    throw stableError("target_run_scope_parent_invalid");
  }
  let root;
  try {
    root = await mkdtemp(path.join(parentDirectory, `symphony-target-${runId}-`));
    const scope = {
      runId,
      root,
      appDataRoot: path.join(root, "app-data"),
      conductorDataRoot: path.join(root, "conductor"),
      codexHomeRoot: path.join(root, "codex-home"),
      evidenceRoot: path.join(root, "evidence"),
    };
    await Promise.all([
      scope.appDataRoot,
      scope.conductorDataRoot,
      scope.codexHomeRoot,
      scope.evidenceRoot,
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    await writeFile(path.join(root, SCOPE_MARKER), `${runId}\n`, { mode: 0o600 });
    return Object.freeze(scope);
  } catch {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
    throw stableError("target_run_scope_create_failed");
  }
}

export async function cleanupTargetRunScope(scope) {
  validateScope(scope, "target_run_scope_cleanup_invalid");
  let owner;
  try {
    owner = (await readFile(path.join(scope.root, SCOPE_MARKER), "utf8")).trim();
  } catch {
    throw stableError("target_run_scope_cleanup_invalid");
  }
  if (owner !== scope.runId || !path.basename(scope.root).startsWith(`symphony-target-${scope.runId}-`)) {
    throw stableError("target_run_scope_cleanup_invalid");
  }
  try {
    await rm(scope.root, { recursive: true, force: true });
  } catch {
    throw stableError("target_run_scope_cleanup_failed");
  }
}

export async function createTargetGitFixture({ scope } = {}) {
  validateScope(scope, "target_git_fixture_scope_invalid");
  const repositoryRoot = path.join(scope.root, "repository");
  try {
    await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(repositoryRoot, "README.md"),
      `# Symphony target E2E\n\nRun: ${scope.runId}\n`,
      { mode: 0o600 },
    );
    await git(repositoryRoot, ["init", "-b", "main"]);
    await git(repositoryRoot, ["config", "user.name", "Symphony Target E2E"]);
    await git(repositoryRoot, ["config", "user.email", "target-e2e@symphony.local"]);
    await git(repositoryRoot, ["add", "README.md"]);
    await git(repositoryRoot, ["commit", "-m", "Initialize target Git fixture"]);
    const head = (await git(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (!SHA.test(head)) throw stableError("target_git_fixture_commit_invalid");
    return Object.freeze({ repositoryRoot, baseBranch: "main", initialCommit: head });
  } catch (error) {
    throw isStableError(error) ? error : stableError("target_git_fixture_create_failed");
  }
}

export async function readTargetGitObservation({ repositoryRoot, branch, worktreePath } = {}) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0 ||
      (branch !== undefined && !BRANCH.test(branch)) ||
      (worktreePath !== undefined && (typeof worktreePath !== "string" || worktreePath.length === 0))) {
    throw stableError("target_git_observation_input_invalid");
  }
  const targetPath = worktreePath ?? repositoryRoot;
  try {
    const [repositoryIdentity, commonGitDir, targetCommonGitDir, branchResult, headResult, statusResult] =
      await Promise.all([
        realpath(repositoryRoot),
        git(repositoryRoot, ["rev-parse", "--git-common-dir"]),
        git(targetPath, ["rev-parse", "--git-common-dir"]),
        git(targetPath, ["branch", "--show-current"]),
        git(targetPath, ["rev-parse", "HEAD"]),
        git(targetPath, ["status", "--porcelain=v1", "--untracked-files=all"]),
      ]);
    const observedBranch = branchResult.stdout.trim();
    const head = headResult.stdout.trim();
    const commonRoot = await realpath(resolveGitPath(repositoryRoot, commonGitDir.stdout.trim()));
    const targetCommonRoot = await realpath(resolveGitPath(targetPath, targetCommonGitDir.stdout.trim()));
    if ((branch !== undefined && observedBranch !== branch) || !BRANCH.test(observedBranch) ||
        !SHA.test(head) || statusResult.stdout.trim() !== "" ||
        commonRoot !== targetCommonRoot) {
      throw stableError("target_git_observation_mismatch");
    }
    return Object.freeze({
      repositoryIdentity,
      branch: observedBranch,
      head,
      clean: true,
    });
  } catch (error) {
    throw isStableError(error) ? error : stableError("target_git_observation_read_failed");
  }
}

async function git(repositoryRoot, arguments_) {
  try {
    return await execute("git", ["-C", repositoryRoot, ...arguments_], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1_048_576,
    });
  } catch {
    throw stableError("target_git_command_failed");
  }
}

function resolveGitPath(repositoryRoot, value) {
  return value && path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
}

function validateScope(scope, errorCode) {
  if (!scope || typeof scope !== "object" || !RUN_ID.test(scope.runId ?? "") ||
      typeof scope.root !== "string" || !path.basename(scope.root).startsWith(`symphony-target-${scope.runId}-`)) {
    throw stableError(errorCode);
  }
}

function validateRunId(runId, errorCode) {
  if (!RUN_ID.test(runId ?? "")) throw stableError(errorCode);
}

function stableError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isStableError(error) {
  return error instanceof Error && /^[a-z][a-z0-9_]{1,120}$/u.test(error.message);
}
