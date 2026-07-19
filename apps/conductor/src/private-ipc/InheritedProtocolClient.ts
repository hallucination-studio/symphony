import { decodePodiumConductorPodiumConductorMessage } from "@symphony/contracts";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type ProtocolMessage = {
  protocol_version: "1";
  request_id: string;
  body: JsonValue;
};

type RequestHandler = {
  handleRequest(body: JsonValue, secret?: Uint8Array): Promise<JsonValue>;
};

const MAX_FRAME_BYTES = 1_048_576;
const PROFILE_REQUEST_KINDS = new Set([
  "get_profiles",
  "get_profile_status",
  "start_chatgpt_login",
  "set_api_key",
  "activate_profile",
  "create_profile",
  "update_profile",
  "shutdown_conductor",
  "acknowledge_root_retry_block",
]);

export class InheritedProtocolClient {
  readonly #pending = new Map<
    string,
    {
      resolve(body: JsonValue): void;
      reject(error: Error): void;
      timeout: NodeJS.Timeout;
    }
  >();
  #buffer = Buffer.alloc(0);
  #processing = Promise.resolve();
  #closedError: Error | undefined;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly handler?: RequestHandler,
  ) {
    input.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      this.#processing = this.#processing
        .then(() => this.#drain())
        .catch(() => this.#close(new Error("private_ipc_read_failed")));
    });
    input.once("error", (error) => this.#close(error));
    input.once("end", () => {
      void this.#processing.finally(() => {
        if (this.#buffer.byteLength > 0) {
          this.#close(new Error("private_ipc_frame_incomplete"));
        } else {
          this.#close(new Error("private_ipc_closed"));
        }
      });
    });
  }

  request(input: {
    requestId: string;
    body: JsonValue;
    timeoutMs: number;
  }): Promise<JsonValue> {
    if (this.#closedError) return Promise.reject(this.#closedError);
    if (
      !Number.isFinite(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 300_000 ||
      this.#pending.has(input.requestId)
    ) {
      return Promise.reject(new Error("private_ipc_request_invalid"));
    }
    const message = validateMessage({
      protocol_version: "1",
      request_id: input.requestId,
      body: input.body,
    });
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame, "utf8") > MAX_FRAME_BYTES) {
      return Promise.reject(new Error("private_ipc_frame_too_large"));
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(input.requestId);
        reject(new Error("private_ipc_request_timeout"));
      }, input.timeoutMs);
      this.#pending.set(input.requestId, { resolve, reject, timeout });
      this.output.write(frame, (error) => {
        if (!error) return;
        const pending = this.#pending.get(input.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(input.requestId);
        pending.reject(new Error("private_ipc_write_failed"));
      });
    });
  }

  async #drain(): Promise<void> {
    while (!this.#closedError) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength > MAX_FRAME_BYTES) {
          this.#close(new Error("private_ipc_frame_too_large"));
        }
        return;
      }
      if (newline > MAX_FRAME_BYTES) {
        this.#close(new Error("private_ipc_frame_too_large"));
        return;
      }
      const line = this.#buffer.subarray(0, newline).toString("utf8");
      let message: ProtocolMessage;
      try {
        message = validateMessage(JSON.parse(line));
      } catch (error) {
        this.#close(
          new Error(
            error instanceof SyntaxError
              ? "private_ipc_json_invalid"
              : "private_ipc_message_invalid",
          ),
        );
        return;
      }
      const secretLength = profileSecretLength(message.body);
      const frameLength = newline + 1 + secretLength;
      if (this.#buffer.byteLength < frameLength) return;
      const secret =
        secretLength > 0
          ? Buffer.from(this.#buffer.subarray(newline + 1, frameLength))
          : undefined;
      this.#buffer = this.#buffer.subarray(frameLength);
      await this.#receive(message, secret);
    }
  }

  async #receive(message: ProtocolMessage, secret?: Buffer): Promise<void> {
    const pending = this.#pending.get(message.request_id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete(message.request_id);
      secret?.fill(0);
      pending.resolve(message.body);
      return;
    }
    if (!this.handler || !isIncomingRequest(message.body)) {
      secret?.fill(0);
      return;
    }
    let result: JsonValue;
    try {
      result = await this.handler.handleRequest(message.body, secret);
    } catch (error) {
      result = {
        kind: "profile_relay_failed",
        error: {
          code: sanitizedCode(error),
          category: "performer_profile",
          sanitized_reason: sanitizedCode(error),
          retryable: false,
          action_required: "check_profile",
          next_action: "Resolve the Profile problem before retrying.",
        },
      };
    } finally {
      secret?.fill(0);
    }
    const response = validateMessage({
      protocol_version: "1",
      request_id: message.request_id,
      body: result,
    });
    await writeFrame(this.output, `${JSON.stringify(response)}\n`);
  }

  #close(error: Error): void {
    if (this.#closedError) return;
    this.#closedError = error;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function validateMessage(value: unknown): ProtocolMessage {
  return decodePodiumConductorPodiumConductorMessage(
    value as JsonValue,
  ) as unknown as ProtocolMessage;
}

function isIncomingRequest(body: JsonValue): boolean {
  return (
    isRecord(body) &&
    typeof body.kind === "string" &&
    PROFILE_REQUEST_KINDS.has(body.kind)
  );
}

function profileSecretLength(body: JsonValue): number {
  if (!isRecord(body) || body.kind !== "set_api_key") return 0;
  return typeof body.secret_frame_length === "number"
    ? body.secret_frame_length
    : 0;
}

function sanitizedCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[a-z][a-z0-9_]{1,120}$/.test(error.message)
  ) {
    return error.message;
  }
  return "profile_relay_failed";
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeFrame(
  output: NodeJS.WritableStream,
  frame: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(frame, (error) => {
      if (error) reject(new Error("private_ipc_write_failed"));
      else resolve();
    });
  });
}
