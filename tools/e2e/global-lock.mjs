import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

export function lockPathForConfig(root) {
  return path.join(root, ".symphony-e2e.lock");
}

export async function acquireGlobalLock(config, owner) {
  await mkdir(path.dirname(config.paths.lock), { recursive: true });
  let handle;
  try {
    handle = await open(config.paths.lock, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ runId: owner.runId, acquiredAt: new Date().toISOString() }) + "\n", "utf8");
  } catch (error) {
    if (handle) await handle.close();
    if (error?.code === "EEXIST") {
      throw new Error("e2e_lock_unavailable");
    }
    throw new Error("e2e_lock_create_failed");
  }
  return {
    async release() {
      await handle.close();
      await unlink(config.paths.lock).catch((error) => {
        if (error?.code !== "ENOENT") throw new Error("e2e_lock_release_failed");
      });
    },
  };
}
