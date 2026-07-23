import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_TIMEOUT_MS = 5 * 60_000;
const TIMEOUT_EXIT_CODE = 124;
const TERMINATION_GRACE_MS = 250;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { command, arguments_, timeoutMs } = parseArguments(process.argv.slice(2));
  const child = spawn(command, arguments_, {
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let finished = false;
  let timeoutRequested = false;
  const graceMs = Math.min(TERMINATION_GRACE_MS, Math.max(1, Math.floor(timeoutMs / 4)));

  const softTimer = setTimeout(() => {
    if (finished) return;
    timeoutRequested = true;
    killProcessTree(child, "SIGTERM");
  }, timeoutMs - graceMs);

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    killProcessTree(child, "SIGKILL");
    process.stderr.write('{"status":"failed","reason":"target_command_timeout"}\n');
    process.exit(TIMEOUT_EXIT_CODE);
  }, timeoutMs);

  child.once("error", () => {
    if (finished) return;
    finished = true;
    clearTimeout(softTimer);
    clearTimeout(timer);
    process.exit(timeoutRequested ? TIMEOUT_EXIT_CODE : 1);
  });
  child.once("exit", (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(softTimer);
    clearTimeout(timer);
    if (timeoutRequested) {
      killProcessTree(child, "SIGKILL");
      process.stderr.write('{"status":"failed","reason":"target_command_timeout"}\n');
      process.exit(TIMEOUT_EXIT_CODE);
    }
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 1;
  });
}

function parseArguments(arguments_) {
  let index = 0;
  let timeoutMs = MAX_TIMEOUT_MS;
  if (arguments_[index] === "--timeout-ms") {
    timeoutMs = Number(arguments_[index + 1]);
    index += 2;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS ||
      arguments_[index] !== "--" || typeof arguments_[index + 1] !== "string") {
    throw new Error("target_command_arguments_invalid");
  }
  return Object.freeze({
    command: arguments_[index + 1],
    arguments_: Object.freeze(arguments_.slice(index + 2)),
    timeoutMs,
  });
}

export function killProcessTree(child, signal = "SIGKILL") {
  if (!child.pid) return;
  const descendants = listDescendantPids(child.pid);
  for (const pid of descendants) {
    killProcessGroup(pid, signal);
  }
  killProcessGroup(child.pid, signal);
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between discovery and termination.
  }
}

function listDescendantPids(rootPid) {
  if (process.platform === "win32") return [];
  let output;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const childrenByParent = new Map();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  const descendants = [];
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined) continue;
    descendants.push(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants.sort((left, right) => right - left);
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error)) throw error;
    if (error.code === "ESRCH") return;
    if (error.code !== "EPERM") throw error;
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if (!(fallbackError instanceof Error && "code" in fallbackError && fallbackError.code === "ESRCH")) {
        throw fallbackError;
      }
    }
  }
}

export { parseArguments };
