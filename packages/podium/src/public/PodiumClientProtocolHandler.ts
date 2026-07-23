import { decodePodiumClientPodiumClientMessage } from "@symphony/contracts";

import type { JsonValue } from "./DesktopViewInterface.js";

type ClientMessage = {
  protocol_version: "1";
  request_id: string;
  body: Record<string, JsonValue> & { kind: string };
};

export interface PodiumClientServices {
  completeOAuth(input: {
    state: string;
    authorizationCode: string;
  }): Promise<JsonValue>;
  query(body: ClientMessage["body"]): Promise<JsonValue>;
  command(body: ClientMessage["body"]): Promise<JsonValue>;
  setApiKey(input: {
    conductorId: string;
    profileId: string;
    secret: Uint8Array;
  }): Promise<JsonValue>;
}

export type PodiumClientResponse =
  | {
      protocol_version: "1";
      request_id: string;
      body: JsonValue;
    }
  | {
      protocol_version: "1";
      request_id: string;
      body: {
        code: string;
        category: "podium_client";
        sanitized_reason: string;
        retryable: false;
        action_required: "retry_request";
        next_action: string;
      };
    };

const queryKinds = new Set([
  "get_desktop_overview",
  "get_conductor_detail",
  "get_performer_profiles",
  "get_performer_profile_status",
]);

export class PodiumClientProtocolHandler {
  constructor(private readonly services: PodiumClientServices) {}

  async handle(
    value: JsonValue,
    secretFrame?: Uint8Array,
  ): Promise<PodiumClientResponse> {
    let requestId = "invalid-request";
    try {
      const message = decodePodiumClientPodiumClientMessage(
        value,
      ) as unknown as ClientMessage;
      requestId = message.request_id;
      const body =
        message.body.kind === "set_codex_api_key"
          ? await this.#setApiKey(message.body, secretFrame)
          : queryKinds.has(message.body.kind)
            ? await this.services.query(message.body)
            : await this.services.command(message.body);
      return decodePodiumClientPodiumClientMessage({
        protocol_version: "1",
        request_id: requestId,
        body,
      }) as unknown as PodiumClientResponse;
    } catch (error) {
      secretFrame?.fill(0);
      return {
        protocol_version: "1",
        request_id: requestId,
        body: protocolFailure(error),
      };
    }
  }

  async #setApiKey(
    body: ClientMessage["body"],
    secretFrame: Uint8Array | undefined,
  ): Promise<JsonValue> {
    if (
      typeof body.conductor_id !== "string" ||
      typeof body.profile_id !== "string" ||
      typeof body.secret_frame_length !== "number" ||
      !secretFrame ||
      secretFrame.byteLength !== body.secret_frame_length
    ) {
      throw new Error("podium_client_secret_frame_mismatch");
    }
    try {
      return await this.services.setApiKey({
        conductorId: body.conductor_id,
        profileId: body.profile_id,
        secret: secretFrame,
      });
    } finally {
      secretFrame.fill(0);
    }
  }
}

function protocolFailure(error: unknown) {
  const code =
    error instanceof Error && /^podium_[a-z0-9_]{1,120}$/.test(error.message)
      ? error.message
      : "podium_client_request_failed";
  return {
    code,
    category: "podium_client" as const,
    sanitized_reason:
      code === "podium_client_request_failed"
        ? "Podium could not complete the request."
        : code,
    retryable: false as const,
    action_required: "retry_request" as const,
    next_action: "Retry after resolving the reported local runtime problem.",
  };
}
