import { readFile, unlink } from "node:fs/promises";

import { lockPathForConfig } from "./global-lock.mjs";

const runId = process.env.SYMPHONY_E2E_RUN_ID;
if (!runId || !/^[A-Za-z0-9._-]{1,128}$/u.test(runId)) {
  throw new Error("e2e_cleanup_run_id_invalid");
}

const lockPath = lockPathForConfig(process.cwd());
const owner = await readOwner(lockPath);
if (owner === runId) {
  await unlink(lockPath);
  process.stdout.write('{"status":"cleaned","target":"run_lock"}\n');
} else {
  process.stdout.write('{"status":"skipped","reason":"run_lock_not_owned"}\n');
}

async function readOwner(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return typeof value?.runId === "string" ? value.runId : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("e2e_cleanup_lock_invalid");
  }
}
