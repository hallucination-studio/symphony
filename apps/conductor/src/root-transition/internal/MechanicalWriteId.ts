import { createHash } from "node:crypto";

export function mechanicalWriteId(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
  return `mechanical:${digest}`;
}
