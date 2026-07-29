import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import type { RootIssueId } from "../../contracts/identity.js";
import { RootContinuityStore } from "./RootContinuityStore.js";

export interface RootHome {
  readonly rootId: RootIssueId;
  readonly path: string;
  readonly continuity: RootContinuityStore;
}

function canonicalKey(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalExisting(value: string, code: string): Promise<string> {
  try { return path.normalize(await realpath(value)); } catch { throw new Error(code); }
}

export class RootHomeManager {
  readonly #programData: string;
  readonly #performerHome: string;

  private constructor(programData: string, performerHome: string) {
    this.#programData = programData;
    this.#performerHome = performerHome;
  }

  static async create(programData: string, performerHome: string): Promise<RootHomeManager> {
    const canonicalProgramData = await canonicalExisting(programData, "invalid_program_data_path");
    const canonicalPerformerHome = await canonicalExisting(performerHome, "invalid_performer_home");
    const programKey = canonicalKey(canonicalProgramData);
    const performerKey = canonicalKey(canonicalPerformerHome);
    if (
      contains(programKey, performerKey)
      || contains(performerKey, programKey)
    ) {
      throw new Error("root_and_performer_homes_overlap");
    }
    return new RootHomeManager(canonicalProgramData, canonicalPerformerHome);
  }

  pathFor(rootId: RootIssueId): string {
    const encoded = Buffer.from(rootId, "utf8").toString("hex");
    return path.join(this.#programData, "root-reconcills", encoded);
  }

  async open(rootId: RootIssueId): Promise<RootHome> {
    const rootPath = this.pathFor(rootId);
    await mkdir(path.join(rootPath, "symphony"), { recursive: true, mode: 0o700 });
    await this.#assertOwnedPath(rootId, rootPath);
    return Object.freeze({ rootId, path: rootPath, continuity: new RootContinuityStore(rootPath) });
  }

  async delete(rootId: RootIssueId, isLive: (rootId: RootIssueId) => boolean): Promise<void> {
    if (isLive(rootId)) throw new Error("root_runtime_is_live");
    const rootPath = this.pathFor(rootId);
    await this.#assertOwnedPath(rootId, rootPath);
    const continuity = new RootContinuityStore(rootPath);
    const state = await continuity.load();
    if (state.root_id !== rootId) throw new Error("root_home_owner_mismatch");
    await rm(rootPath, { recursive: true, force: false });
  }

  async #assertOwnedPath(rootId: RootIssueId, rootPath: string): Promise<void> {
    const stat = await lstat(rootPath).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("invalid_root_home");
    const actual = await canonicalExisting(rootPath, "invalid_root_home");
    const actualKey = canonicalKey(actual);
    const expectedKey = canonicalKey(this.pathFor(rootId));
    if (
      actualKey !== expectedKey
      || !contains(canonicalKey(this.#programData), actualKey)
      || contains(canonicalKey(this.#performerHome), actualKey)
    ) {
      throw new Error("root_home_path_escape");
    }
  }
}
