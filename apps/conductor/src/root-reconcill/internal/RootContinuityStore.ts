import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { parseRootRuntimeState, type RootRuntimeState } from "../../contracts/runtime.js";

const STATE_DIRECTORY = "symphony";
const STATE_FILE = "state.json";

export class RootContinuityStore {
  constructor(private readonly rootHome: string) {}

  get statePath(): string { return path.join(this.rootHome, STATE_DIRECTORY, STATE_FILE); }

  async load(): Promise<RootRuntimeState> {
    let source: string;
    try {
      source = await readFile(this.statePath, "utf8");
    } catch {
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
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.statePath);
      const directoryHandle = await open(directory, "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
