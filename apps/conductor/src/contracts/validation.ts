import { fromMarkdown } from "mdast-util-from-markdown";

export type UnknownRecord = Record<string, unknown>;

export const MAX_MARKDOWN_TEXT_LENGTH = 100_000;

declare const markdownTextBrand: unique symbol;

export type MarkdownText = string & { readonly [markdownTextBrand]: true };

interface MarkdownNode {
  readonly type: string;
  readonly children?: readonly MarkdownNode[];
}

function markdownSyntaxTree(value: string): unknown {
  const stripPosition = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stripPosition);
    if (typeof entry !== "object" || entry === null) return entry;
    return Object.fromEntries(
      Object.entries(entry)
        .filter(([key]) => key !== "position" && key !== "spread")
        .map(([key, child]) => [key, stripPosition(child)]),
    );
  };
  return stripPosition(fromMarkdown(value));
}

export function markdownSemanticallyEqual(left: string, right: string): boolean {
  try {
    return JSON.stringify(markdownSyntaxTree(left)) === JSON.stringify(markdownSyntaxTree(right));
  } catch {
    return false;
  }
}

const CREDENTIAL_MATERIAL = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAuthorization\s*[:=]\s*[A-Za-z][A-Za-z0-9_-]{1,31}\s+[A-Za-z0-9._~+/-]{8,}={0,2}/iu,
  /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]{8,}/iu,
  /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
] as const;

export function containsCredentialMaterial(value: string): boolean {
  return CREDENTIAL_MATERIAL.some((pattern) => pattern.test(value));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isBareJsonContainer(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function containsHtml(root: MarkdownNode): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.type === "html") return true;
    for (const child of node.children ?? []) pending.push(child);
  }
  return false;
}

export function parseMarkdownText(
  value: unknown,
  code = "invalid_markdown_text",
  max = MAX_MARKDOWN_TEXT_LENGTH,
): MarkdownText {
  if (
    typeof value !== "string"
    || value.length > max
    || value.trim().length === 0
    || value.includes("\0")
    || hasUnpairedSurrogate(value)
    || isBareJsonContainer(value)
    || containsCredentialMaterial(value)
  ) throw new Error(code);

  const tree = fromMarkdown(value) as MarkdownNode;
  if (containsHtml(tree)) throw new Error(code);
  return value as MarkdownText;
}

export function asRecord(value: unknown, code = "invalid_contract"): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as UnknownRecord;
}

export function assertExactKeys(record: UnknownRecord, keys: readonly string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid_contract_keys");
  }
}

export function parseEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error("invalid_contract_variant");
  return value as T[number];
}

export function parseBoundedString(value: unknown, code: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\r\n\0]/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

export function parseArray<T>(
  value: unknown,
  parser: (entry: unknown) => T,
  max = 5_000,
): readonly T[] {
  if (!Array.isArray(value)) throw new Error("invalid_contract_array");
  if (value.length > max) throw new Error("contract_array_limit_exceeded");
  return Object.freeze(value.map(parser));
}

export function parseStringArray(
  value: unknown,
  parser: (entry: unknown) => string,
  max = 5_000,
): readonly string[] {
  const parsed = parseArray(value, parser, max);
  if (new Set(parsed).size !== parsed.length) throw new Error("duplicate_contract_identity");
  return parsed;
}
