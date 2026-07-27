const MANAGED_RECORD_BLOCK = /^```json\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gmu;
const RETIRED_SYMPHONY_BLOCK = /^```symphony\r?\n/mu;
const RETIRED_HTML_MARKER = /<!--\s*symphony\s+managed-record\b/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function parseManagedRecordBlock(source) {
  if (typeof source !== "string") return failure("managed_record_block_invalid");
  const blocks = [...source.matchAll(MANAGED_RECORD_BLOCK)];
  if (blocks.length === 0) {
    return RETIRED_SYMPHONY_BLOCK.test(source) || RETIRED_HTML_MARKER.test(source)
      ? failure("managed_record_block_legacy_format")
      : failure("managed_record_block_missing");
  }
  if (blocks.length > 1) return failure("managed_record_block_ambiguous");
  const block = blocks[0];
  if (source.slice((block.index ?? 0) + block[0].length).trim()) {
    return failure("managed_record_block_not_terminal");
  }
  const content = block[1].trim();
  if (!content) return failure("managed_record_block_invalid");
  try {
    const record = JSON.parse(content);
    if (!object(record) || typeof record.kind !== "string" || !IDENTIFIER.test(record.kind)) {
      return failure("managed_record_block_invalid");
    }
    if (record.version !== 1) return failure("managed_record_version_invalid");
    return Object.freeze({
      ok: true,
      markdown: source.slice(0, block.index).trimEnd(),
      record: Object.freeze(record),
    });
  } catch {
    return failure("managed_record_block_invalid");
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(error) {
  return Object.freeze({ ok: false, error });
}
