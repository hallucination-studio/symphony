type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type Message = {
  protocol_version: "1";
  request_id: string;
  body: JsonValue;
};

const MAX_FRAME_BYTES = 1_048_576;

export class FramedProtocolPeer {
  readonly #pending = new Map<
    string,
    {
      resolve(value: JsonValue): void;
      reject(error: Error): void;
      timeout: NodeJS.Timeout;
    }
  >();
  #buffer = Buffer.alloc(0);
  #processing = Promise.resolve();
  #closed: Error | undefined;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly options: {
      decode(value: JsonValue): JsonValue;
      secretLength(body: JsonValue): number;
      handleRequest?(
        body: JsonValue,
        secret?: Uint8Array,
      ): Promise<JsonValue>;
    },
  ) {
    input.on("data", (chunk: Buffer | string) => {
      this.#buffer = Buffer.concat([
        this.#buffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
      ]);
      this.#processing = this.#processing
        .then(() => this.#drain())
        .catch(() => this.#fail(new Error("private_peer_read_failed")));
    });
    input.once("error", () => this.#fail(new Error("private_peer_read_failed")));
    input.once("end", () => this.#fail(new Error("private_peer_closed")));
  }

  request(input: {
    requestId: string;
    body: JsonValue;
    secret?: Uint8Array;
    timeoutMs: number;
  }): Promise<JsonValue> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#pending.has(input.requestId)) {
      return Promise.reject(new Error("private_peer_request_duplicate"));
    }
    const message = this.#decode({
      protocol_version: "1",
      request_id: input.requestId,
      body: input.body,
    });
    const metadata = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    const secret = input.secret ? Buffer.from(input.secret) : undefined;
    if (
      metadata.byteLength > MAX_FRAME_BYTES ||
      this.options.secretLength(message.body) !== (secret?.byteLength ?? 0)
    ) {
      secret?.fill(0);
      input.secret?.fill(0);
      return Promise.reject(new Error("private_peer_frame_invalid"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(input.requestId);
        reject(new Error("private_peer_request_timeout"));
      }, input.timeoutMs);
      this.#pending.set(input.requestId, { resolve, reject, timeout });
      this.output.write(
        secret ? Buffer.concat([metadata, secret]) : metadata,
        (error) => {
          secret?.fill(0);
          input.secret?.fill(0);
          if (!error) return;
          const pending = this.#pending.get(input.requestId);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.#pending.delete(input.requestId);
          pending.reject(new Error("private_peer_write_failed"));
        },
      );
    });
  }

  async #drain(): Promise<void> {
    while (!this.#closed) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength > MAX_FRAME_BYTES) {
          this.#fail(new Error("private_peer_frame_too_large"));
        }
        return;
      }
      let message: Message;
      try {
        message = this.#decode(
          JSON.parse(this.#buffer.subarray(0, newline).toString("utf8")),
        );
      } catch {
        this.#fail(new Error("private_peer_message_invalid"));
        return;
      }
      const secretLength = this.options.secretLength(message.body);
      const consumed = newline + 1 + secretLength;
      if (this.#buffer.byteLength < consumed) return;
      const secret =
        secretLength > 0
          ? Buffer.from(this.#buffer.subarray(newline + 1, consumed))
          : undefined;
      this.#buffer = this.#buffer.subarray(consumed);
      const pending = this.#pending.get(message.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(message.request_id);
        pending.resolve(message.body);
        secret?.fill(0);
        continue;
      }
      if (!this.options.handleRequest) {
        secret?.fill(0);
        continue;
      }
      try {
        const body = await this.options.handleRequest(message.body, secret);
        const response = this.#decode({
          protocol_version: "1",
          request_id: message.request_id,
          body,
        });
        await write(this.output, Buffer.from(`${JSON.stringify(response)}\n`));
      } finally {
        secret?.fill(0);
      }
    }
  }

  #decode(value: JsonValue): Message {
    return this.options.decode(value) as unknown as Message;
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function write(
  output: NodeJS.WritableStream,
  bytes: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(bytes, (error) => {
      if (error) reject(new Error("private_peer_write_failed"));
      else resolve();
    });
  });
}
