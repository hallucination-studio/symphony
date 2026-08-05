import { execFile } from "node:child_process";
import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const BINDING_FILE = "root-binding.json";

export interface RootWorkspaceInput {
  readonly rootId: string;
  readonly workspace: string;
  readonly runDirectory: string;
}

export interface BoundRootWorkspace {
  readonly rootId: string;
  readonly workspacePath: string;
  readonly runDirectory: string;
  readonly rootBranch: string;
}

interface BindingRecord {
  readonly root_id: string;
  readonly workspace_path: string;
  readonly run_directory: string;
  readonly root_branch: string;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function git(workspace: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execute("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return result.stdout.trim();
  } catch {
    throw new Error("invalid_root_workspace");
  }
}

function parseBinding(source: string): BindingRecord {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error("invalid_root_binding"); }
  if (typeof value !== "object" || value === null) throw new Error("invalid_root_binding");
  const record = value as Record<string, unknown>;
  for (const key of ["root_id", "workspace_path", "run_directory", "root_branch"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) throw new Error("invalid_root_binding");
  }
  return record as unknown as BindingRecord;
}

async function persistBinding(file: string, record: BindingRecord): Promise<void> {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function bindRootWorkspace(input: RootWorkspaceInput): Promise<BoundRootWorkspace> {
  if (input.rootId.trim().length === 0) throw new Error("invalid_root_id");
  let workspacePath: string;
  let runDirectory: string;
  try {
    [workspacePath, runDirectory] = await Promise.all([
      realpath(input.workspace),
      realpath(input.runDirectory),
    ]);
  } catch {
    throw new Error("supplied_path_unavailable");
  }
  if (contains(workspacePath, runDirectory)) throw new Error("run_directory_inside_workspace");

  const topLevel = await git(workspacePath, ["rev-parse", "--show-toplevel"]);
  if (await realpath(topLevel) !== workspacePath) throw new Error("workspace_is_not_git_root");
  const rootBranch = await git(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => { throw new Error("workspace_branch_unavailable"); });
  const remotes = await git(workspacePath, ["remote"]);
  if (remotes.split("\n").filter(Boolean).length === 0) throw new Error("workspace_remote_unavailable");

  const probe = path.join(runDirectory, `.write-probe.${process.pid}.${crypto.randomUUID()}`);
  const probeHandle = await open(probe, "wx", 0o600).catch(() => { throw new Error("run_directory_not_writable"); });
  await probeHandle.close();
  await unlink(probe);

  const record = Object.freeze({
    root_id: input.rootId,
    workspace_path: workspacePath,
    run_directory: runDirectory,
    root_branch: rootBranch,
  });
  const bindingPath = path.join(runDirectory, BINDING_FILE);
  let existing: BindingRecord | null = null;
  try { existing = parseBinding(await readFile(bindingPath, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== null) {
    if (JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("root_binding_mismatch");
  } else {
    await persistBinding(bindingPath, record);
  }

  return Object.freeze({
    rootId: record.root_id,
    workspacePath: record.workspace_path,
    runDirectory: record.run_directory,
    rootBranch: record.root_branch,
  });
}
