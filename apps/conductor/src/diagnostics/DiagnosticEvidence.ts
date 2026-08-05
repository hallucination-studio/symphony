import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

const MAX_DEPTH = 12;
const MAX_ENTRIES = 1_000;
const MAX_STRING_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 4 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function pathError(): Error {
  return new Error("diagnostic_path_invalid");
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || !path.isAbsolute(value)
    || value.includes("\0")
  ) throw pathError();
  return path.resolve(value);
}

function runId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_RUN_ID.test(value)) throw pathError();
  return value;
}

function notFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertNoSymlinkComponents(pathname: string): Promise<void> {
  const parsed = path.parse(pathname);
  let current = parsed.root;
  const relative = path.relative(parsed.root, pathname);
  for (const [index, component] of relative.split(path.sep).entries()) {
    if (component.length === 0) continue;
    current = path.join(current, component);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (notFound(error)) return;
      throw error;
    }
    // macOS commonly exposes /var as a compatibility symlink to /private/var;
    // allow only that fixed system link and reject links introduced below it.
    if (metadata.isSymbolicLink()) {
      if (!(process.platform === "darwin" && index === 0 && current === "/var")) throw pathError();
      continue;
    }
    if (!metadata.isDirectory()) throw pathError();
  }
}

async function assertExistingDirectory(pathname: string): Promise<void> {
  await assertNoSymlinkComponents(pathname);
  const metadata = await lstat(pathname).catch(() => { throw pathError(); });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw pathError();
}

async function ensurePrivateDirectory(pathname: string): Promise<void> {
  try {
    await lstat(pathname);
  } catch (error) {
    if (!notFound(error)) throw error;
    try {
      await mkdir(pathname, { mode: 0o700 });
    } catch (mkdirError) {
      if (!(
        typeof mkdirError === "object"
        && mkdirError !== null
        && "code" in mkdirError
        && mkdirError.code === "EEXIST"
      )) throw mkdirError;
    }
  }

  await assertExistingDirectory(pathname);
  const directory = await open(
    pathname,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await directory.chmod(0o700);
  } finally {
    await directory.close();
  }
}

async function writePrivateFile(pathname: string, source: string): Promise<void> {
  const file = await open(
    pathname,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(source, "utf8");
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
}

function boundedString(value: string): string {
  return Buffer.byteLength(value) <= MAX_STRING_BYTES
    ? value
    : `${Buffer.from(value).subarray(0, MAX_STRING_BYTES).toString("utf8")}\n[truncated]`;
}

function evidenceValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (depth >= MAX_DEPTH) return "[maximum depth reached]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: boundedString(value.message),
      ...(value.stack === undefined ? {} : { stack: boundedString(value.stack) }),
      ...(value.cause === undefined ? {} : { cause: evidenceValue(value.cause, depth + 1, seen) }),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ENTRIES).map((entry) => evidenceValue(entry, depth + 1, seen));
  }
  const entries = Object.entries(value).slice(0, MAX_ENTRIES);
  return Object.fromEntries(entries.map(([key, entry]) => [key, evidenceValue(entry, depth + 1, seen)]));
}

export function serializeDiagnosticError(error: unknown): unknown {
  return evidenceValue(error);
}

export async function writeFailureEvidence(input: {
  readonly runDirectory: string;
  readonly runId: string;
  readonly phase: string;
  readonly error: unknown;
}): Promise<string> {
  const runDirectory = absolutePath(input.runDirectory);
  const safeRunId = runId(input.runId);
  await assertExistingDirectory(runDirectory);
  const diagnosticsDirectory = path.join(runDirectory, "diagnostics");
  await ensurePrivateDirectory(diagnosticsDirectory);
  const directory = path.join(diagnosticsDirectory, safeRunId);
  await ensurePrivateDirectory(directory);
  const file = path.join(directory, "error.json");
  const source = `${JSON.stringify({
    version: 1,
    event: "conductor_failed",
    run_id: input.runId,
    phase: input.phase,
    recorded_at: new Date().toISOString(),
    error: serializeDiagnosticError(input.error),
  }, null, 2)}\n`;
  if (Buffer.byteLength(source) > MAX_EVIDENCE_BYTES) throw new Error("diagnostic_evidence_too_large");
  await writePrivateFile(file, source);
  return file;
}
