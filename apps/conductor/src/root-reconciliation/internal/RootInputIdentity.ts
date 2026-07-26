import { createHash } from "node:crypto";

export function rootInputId(sourceId: string, sourceVersion: string): string {
  return `input:${createHash("sha256").update(`${sourceId}\u0000${sourceVersion}`, "utf8").digest("hex")}`;
}
