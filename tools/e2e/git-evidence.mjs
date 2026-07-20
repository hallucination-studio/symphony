import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const FILENAME = /^e2e-[a-z]+\.txt$/u;
const SHA = /^[0-9a-f]{40}$/u;

export async function readRootGitEvidence({
  repositoryRoot,
  branch,
  baselineHead,
  filename,
  expectedContent,
} = {}) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot || !BRANCH.test(branch ?? "") ||
      !SHA.test(baselineHead ?? "") || !FILENAME.test(filename ?? "") ||
      typeof expectedContent !== "string") {
    throw gitEvidenceError("e2e_git_evidence_invalid");
  }

  const worktrees = parseWorktrees((await git(repositoryRoot, ["worktree", "list", "--porcelain"])).stdout);
  const matches = worktrees.filter((worktree) => worktree.branch === branch);
  if (matches.length !== 1) throw gitEvidenceError("e2e_workspace_identity_mismatch");
  const workspace = matches[0];
  const [headResult, baselineCommonResult, workspaceCommonResult, statusResult, diffResult,
    contentResult, commitCountResult] = await Promise.all([
      git(repositoryRoot, ["rev-parse", branch]),
      git(repositoryRoot, ["rev-parse", "--git-common-dir"]),
      git(workspace.path, ["rev-parse", "--git-common-dir"]),
      git(workspace.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
      git(repositoryRoot, ["diff", "--name-only", `${baselineHead}..${branch}`, "--"]),
      git(repositoryRoot, ["show", `${branch}:${filename}`]),
      git(repositoryRoot, ["rev-list", "--count", `${baselineHead}..${branch}`]),
    ]);
  const head = headResult.stdout.trim();
  let baselineCommonDir;
  let workspaceCommonDir;
  try {
    [baselineCommonDir, workspaceCommonDir] = await Promise.all([
      realpath(resolveGitPath(repositoryRoot, baselineCommonResult.stdout.trim())),
      realpath(resolveGitPath(repositoryRoot, workspaceCommonResult.stdout.trim())),
    ]);
  } catch {
    throw gitEvidenceError("e2e_workspace_identity_mismatch");
  }
  const changedPaths = uniqueLines(diffResult.stdout);
  const content = contentResult.stdout;
  const commitCount = Number.parseInt(commitCountResult.stdout.trim(), 10);
  const cleanStatus = statusResult.stdout.trim() === "";

  if (!SHA.test(head) || workspace.head !== head || baselineCommonDir !== workspaceCommonDir) {
    throw gitEvidenceError("e2e_workspace_identity_mismatch");
  }
  if (!cleanStatus) throw gitEvidenceError("e2e_git_worktree_dirty");
  if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
    throw gitEvidenceError("e2e_git_commit_missing");
  }
  if (changedPaths.length !== 1 || changedPaths[0] !== filename || content !== expectedContent) {
    throw gitEvidenceError("e2e_git_output_mismatch");
  }

  return Object.freeze({
    branch,
    baselineHead,
    head,
    changedPaths: Object.freeze(changedPaths),
    outputDigest: createHash("sha256").update(content, "utf8").digest("hex"),
    cleanStatus,
    commitCount,
    commonGitDirValid: true,
  });
}

async function git(repositoryRoot, arguments_) {
  try {
    return await execute("git", ["-C", repositoryRoot, ...arguments_], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1_048_576,
    });
  } catch {
    throw gitEvidenceError("e2e_git_evidence_read_failed");
  }
}

function parseWorktrees(output) {
  const entries = [];
  let current;
  for (const line of output.split("\n")) {
    if (line === "") {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: undefined, head: undefined };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    }
  }
  if (current) entries.push(current);
  return entries.filter((entry) => typeof entry.path === "string" &&
    typeof entry.branch === "string" && typeof entry.head === "string");
}

function uniqueLines(value) {
  return [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))].sort();
}

function resolveGitPath(repositoryRoot, value) {
  if (!value) return "";
  return path.resolve(repositoryRoot, value);
}

function gitEvidenceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
