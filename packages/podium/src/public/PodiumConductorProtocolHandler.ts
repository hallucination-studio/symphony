import { decodePodiumConductorPodiumConductorMessage } from "@symphony/contracts";

import type { JsonValue } from "./DesktopViewInterface.js";

type ProtocolMessage = {
  protocol_version: "1";
  request_id: string;
  body: Record<string, JsonValue> & { kind: string };
};

export interface PodiumConductorServices {
  observeExit(input: {
    bindingId: string;
    instanceId: string;
    observedAt: string;
    sanitizedReason?: string;
  }): void;
  handle(
    body: ProtocolMessage["body"],
    secretFrame?: Uint8Array,
  ): Promise<JsonValue>;
}

export class PodiumConductorProtocolHandler {
  constructor(private readonly services: PodiumConductorServices) {}

  async handle(value: JsonValue, secretFrame?: Uint8Array): Promise<JsonValue> {
    let requestId = "invalid-request";
    try {
      const request = decodePodiumConductorPodiumConductorMessage(
        value,
      ) as unknown as ProtocolMessage;
      requestId = request.request_id;
      const body = await this.services.handle(request.body, secretFrame);
      return decodePodiumConductorPodiumConductorMessage({
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
