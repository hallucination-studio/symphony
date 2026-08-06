import { execFile } from "node:child_process";
import { open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface RootWorkspaceInput {
  readonly rootId: string;
  readonly preferredWorkspace?: string | undefined;
  readonly invocationCwd: string;
  readonly runDirectory: string;
}

export interface BoundRootWorkspace {
  readonly rootId: string;
  readonly workspacePath: string;
  readonly runDirectory: string;
  readonly rootBranch: string;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function git(
  workspace: string,
  args: readonly string[],
  reason = "invalid_root_workspace",
): Promise<string> {
  try {
    const result = await execute("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return result.stdout.trim();
  } catch {
    throw new Error(reason);
  }
}

async function existingPath(value: string, reason: string): Promise<string | undefined> {
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(reason);
  }
}

async function requirePath(value: string, reason: string): Promise<string> {
  const resolved = await existingPath(value, reason);
  if (resolved === undefined) throw new Error(reason);
  return resolved;
}

async function resolveGitRoot(workspace: string): Promise<{ readonly path: string; readonly branch: string }> {
  const topLevel = await git(workspace, ["rev-parse", "--show-toplevel"]);
  const root = await requirePath(topLevel, "invalid_root_workspace");
  const branch = await git(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"], "workspace_branch_unavailable");
  if (branch.length === 0) throw new Error("workspace_branch_unavailable");
  return { path: root, branch };
}

async function gitRoot(workspace: string): Promise<{ readonly path: string; readonly branch: string }> {
  const resolved = await resolveGitRoot(workspace);
  if (resolved.path !== workspace) throw new Error("workspace_is_not_git_root");
  return resolved;
}

async function ensureWritableDirectory(directory: string): Promise<void> {
  const probe = path.join(directory, `.write-probe.${process.pid}.${crypto.randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(probe, "wx", 0o600);
  } catch {
    throw new Error("run_directory_not_writable");
  }
  try {
    await handle.sync();
  } finally {
    await handle.close();
    await unlink(probe).catch(() => undefined);
  }
}

function validateRootId(rootId: string): string {
  const value = rootId.trim();
  if (value.length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("invalid_root_id");
  }
  return value;
}

async function preparePreferredWorkspace(
  preferredWorkspace: string,
  invocationRoot: string,
  rootId: string,
): Promise<{ readonly path: string; readonly branch: string }> {
  const existing = await existingPath(preferredWorkspace, "invalid_root_workspace");
  if (existing !== undefined) return gitRoot(existing);

  const parent = await existingPath(path.dirname(path.resolve(preferredWorkspace)), "preferred_workspace_unavailable");
  if (parent === undefined) throw new Error("preferred_workspace_unavailable");
  const branch = `root/${rootId}`;
  await git(
    invocationRoot,
    ["worktree", "add", "-b", branch, preferredWorkspace, "HEAD"],
    "preferred_workspace_prepare_failed",
  );
  const created = await requirePath(preferredWorkspace, "preferred_workspace_prepare_failed");
  const bound = await gitRoot(created);
  if (bound.branch !== branch) throw new Error("preferred_workspace_branch_mismatch");
  return { path: bound.path, branch: bound.branch };
}

/**
 * Deterministically prepares one Root workspace.  The returned value is the
 * only binding; no filesystem record is written here.
 */
export async function bindRootWorkspace(input: RootWorkspaceInput): Promise<BoundRootWorkspace> {
  const rootId = validateRootId(input.rootId);
  const invocationCwd = await requirePath(input.invocationCwd, "invocation_workspace_unavailable");
  const invocation = await resolveGitRoot(invocationCwd);
  const runDirectory = await requirePath(input.runDirectory, "run_directory_unavailable");

  if (input.preferredWorkspace !== undefined) {
    const preferred = path.resolve(input.preferredWorkspace);
    if (contains(preferred, runDirectory)) throw new Error("run_directory_inside_workspace");
    const workspace = await preparePreferredWorkspace(input.preferredWorkspace, invocation.path, rootId);
    if (contains(workspace.path, runDirectory)) throw new Error("run_directory_inside_workspace");
    await ensureWritableDirectory(runDirectory);
    return Object.freeze({
      rootId,
      workspacePath: workspace.path,
      runDirectory,
      rootBranch: workspace.branch,
    });
  }

  if (contains(invocation.path, runDirectory)) throw new Error("run_directory_inside_workspace");
  await ensureWritableDirectory(runDirectory);
  return Object.freeze({
    rootId,
    workspacePath: invocation.path,
    runDirectory,
    rootBranch: invocation.branch,
  });
}
