import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export class EvidenceReader {
  constructor(world, linear) {
    this.world = world;
    this.linear = linear;
  }

  async readPublicState() {
    return this.linear.snapshot();
  }

  async readWorkspace() {
    const [status, diffStat] = await Promise.all([
      this.world.git(["status", "--porcelain=v1", "--untracked-files=all"]),
      this.world.git(["diff", "--stat"]),
    ]);
    return Object.freeze({ status, diff_stat: diffStat });
  }

  async readRunEvidence() {
    const entries = await readdir(this.world.runDirectory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.world.runDirectory, entry.name);
      const metadata = await lstat(filePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      files.push(Object.freeze({
        name: entry.name,
        bytes: metadata.size,
      }));
    }
    return Object.freeze(files);
  }

  async read() {
    const [publicState, workspace, runEvidence] = await Promise.all([
      this.readPublicState(),
      this.readWorkspace(),
      this.readRunEvidence(),
    ]);
    return Object.freeze({ publicState, workspace, runEvidence });
  }
}
