export type UnknownRecord = Record<string, unknown>;

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
