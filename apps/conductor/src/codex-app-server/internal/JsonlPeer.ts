const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export class JsonlFrameDecoder {
  #buffer = Buffer.alloc(0);
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new Error("invalid_jsonl_frame_limit");
    }
  }

  push(chunk: Uint8Array): readonly Record<string, unknown>[] {
    if (chunk.byteLength === 0) return [];
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: Record<string, unknown>[] = [];
    let newline = this.#buffer.indexOf(0x0a);
    while (newline >= 0) {
      if (newline > this.maxFrameBytes) throw new Error("jsonl_frame_too_large");
      let bytes = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
      if (bytes.byteLength === 0) throw new Error("empty_jsonl_frame");
      let value: unknown;
      try { value = JSON.parse(this.#decoder.decode(bytes)); } catch { throw new Error("malformed_jsonl_frame"); }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("invalid_jsonl_message");
      }
      frames.push(value as Record<string, unknown>);
      newline = this.#buffer.indexOf(0x0a);
    }
    if (this.#buffer.byteLength > this.maxFrameBytes) throw new Error("jsonl_frame_too_large");
    return Object.freeze(frames);
  }

  finish(): void {
    if (this.#buffer.byteLength !== 0) throw new Error("truncated_jsonl_frame");
  }
}

export function encodeJsonl(value: Record<string, unknown>, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength - 1 > maxFrameBytes) throw new Error("jsonl_frame_too_large");
  return bytes;
}
