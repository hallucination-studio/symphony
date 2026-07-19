import {
  decodePodiumConductorProfileRelayMetadata,
  decodePodiumConductorProfileRelayResult,
} from "../contracts-runtime.mjs";

import type {
  PerformerProfileRelayInterface,
  ProfileRelayMetadata,
  ProfileRelayResult,
} from "./api/PerformerProfileRelayInterface.js";

type ApiKeyMetadata = {
  kind: "set_api_key";
  conductor_id: string;
  profile_id: string;
  secret_frame_length: number;
};

export interface ProfileRelayTransportInterface {
  send(
    metadata: ProfileRelayMetadata | ApiKeyMetadata,
    secretFrame?: Uint8Array,
  ): Promise<ProfileRelayResult>;
}

export class ConductorPerformerProfileRelayImpl
  implements PerformerProfileRelayInterface {
  constructor(private readonly transport: ProfileRelayTransportInterface) {}

  async relay(metadata: ProfileRelayMetadata): Promise<ProfileRelayResult> {
    decodePodiumConductorProfileRelayMetadata(metadata);
    const result = await this.transport.send(metadata);
    decodePodiumConductorProfileRelayResult(result);
    return result;
  }

  async setApiKey(input: {
    conductorId: string;
    profileId: string;
    secret: Uint8Array;
  }): Promise<ProfileRelayResult> {
    if (input.secret.byteLength < 1 || input.secret.byteLength > 16_384) {
      input.secret.fill(0);
      throw new Error("profile_secret_frame_invalid");
    }
    try {
      const metadata: ApiKeyMetadata = {
          kind: "set_api_key",
          conductor_id: input.conductorId,
          profile_id: input.profileId,
          secret_frame_length: input.secret.byteLength,
      };
      decodePodiumConductorProfileRelayMetadata(metadata);
      const result = await this.transport.send(
        metadata,
        input.secret,
      );
      decodePodiumConductorProfileRelayResult(result);
      return result;
    } finally {
      input.secret.fill(0);
    }
  }
}
