import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { parseRootRuntimeState, type RootRuntimeState } from "../../contracts/runtime.js";

const STATE_DIRECTORY = "symphony";
const STATE_FILE = "state.json";

export class RootContinuityStore {
  constructor(private readonly rootHome: string) {}

  get statePath(): string { return path.join(this.rootHome, STATE_DIRECTORY, STATE_FILE); }

  async assertReady(): Promise<void> {
    const directory = path.dirname(this.statePath);
    const probe = path.join(directory, `.ready.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error("invalid_continuity_directory");
      handle = await open(probe, "wx", 0o600);
      await handle.close();
      handle = null;
      await unlink(probe);
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(probe).catch(() => undefined);
      throw new Error("root_continuity_unavailable");
    }
  }

  async load(): Promise<RootRuntimeState> {
    const state = await this.loadOptional();
    if (state === null) throw new Error("root_continuity_unavailable");
    return state;
  }

  async loadOptional(): Promise<RootRuntimeState | null> {
    let source: string;
    try {
      source = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      ) return null;
      throw new Error("root_continuity_unavailable");
    }
    try {
      return parseRootRuntimeState(JSON.parse(source));
    } catch {
      throw new Error("invalid_root_continuity");
    }
  }

  async write(state: RootRuntimeState): Promise<void> {
    const parsed = parseRootRuntimeState(state);
    const directory = path.dirname(this.statePath);
    const temporary = path.join(directory, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        handle = null;
        throw error;
      }
      await handle.close();
      handle = null;
      await rename(temporary, this.statePath);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } catch (error) {
        await directoryHandle.close().catch(() => undefined);
        throw error;
      }
      await directoryHandle.close();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
