import type { JsonValue } from "./generated/typescript/contracts.ts";

export type SymphonyRecordBlock =
  | Readonly<{ ok: true; markdown: string; record: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ ok: false; error: string }>;

export function parseSymphonyRecordBlock(source: unknown): SymphonyRecordBlock;
