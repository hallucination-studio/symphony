import { createHash } from "node:crypto";

function identityPart(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 1_024
    || /[\r\n\0]/u.test(value)
  ) throw new Error("invalid_identity_derivation_part");
  return value;
}

export function deriveCycleUuid(
  derivationVersion: string,
  kind: string,
  ...basis: readonly string[]
): string {
  const input = [derivationVersion, kind, ...basis].map(identityPart);
  const bytes = createHash("sha256").update(JSON.stringify(input), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
