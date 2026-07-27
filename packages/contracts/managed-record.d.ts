import type { JsonValue } from "./generated/typescript/contracts.ts";

export type ManagedRecordBlock =
  | Readonly<{ ok: true; markdown: string; record: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ ok: false; error: string }>;

export function parseManagedRecordBlock(source: unknown): ManagedRecordBlock;
