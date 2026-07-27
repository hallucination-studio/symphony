import { decodePodiumConductorMessage } from "@symphony/contracts";

import type { JsonValue } from "./DesktopViewInterface.js";

type ProtocolMessage = {
  protocol_version: "1";
  request_id: string;
  body: Record<string, JsonValue> & { kind: string };
};

export interface PodiumConductorChannel {
  handle(body: ProtocolMessage["body"], secretFrame?: Uint8Array): Promise<JsonValue>;
  isAuthenticated(): boolean;
  close(input?: { observedAt?: string; sanitizedReason?: string }): void;
}

export interface PodiumConductorServices {
  openChannel(input: { bindingId: string; conductorId: string; instanceId: string }): PodiumConductorChannel;
  observeExit(input: {
    bindingId: string;
    instanceId: string;
    observedAt: string;
    sanitizedReason?: string;
  }): void;
}

export class PodiumConductorProtocolHandler {
  constructor(private readonly channel: PodiumConductorChannel) {}

  async handle(value: JsonValue, secretFrame?: Uint8Array): Promise<JsonValue> {
    let requestId = "invalid-request";
    try {
      const request = decodePodiumConductorMessage(
        value,
      ) as unknown as ProtocolMessage;
      requestId = request.request_id;
      const body = await this.channel.handle(request.body, secretFrame);
      return decodePodiumConductorMessage({
        protocol_version: "1",
        request_id: requestId,
        body,
      }) as unknown as JsonValue;
    } catch (error) {
      secretFrame?.fill(0);
      return {
        protocol_version: "1",
        request_id: requestId,
        body: protocolFailure(error),
      };
    }
  }
}

function protocolFailure(error: unknown) {
  const code =
    error instanceof Error && /^(?:linear|profile|conductor|private)_[a-z0-9_]{1,120}$/.test(error.message)
      ? error.message
      : "podium_conductor_request_failed";
  return {
    code,
    category: "podium_conductor",
    sanitized_reason:
      code === "podium_conductor_request_failed"
        ? "Podium could not complete the Conductor request."
        : code,
    retryable: false,
    action_required: "block_root",
    next_action: "Resolve the reported Podium or Linear problem, then retry.",
  };
}
