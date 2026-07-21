import { decodeConductorPerformerPerformerProfileControlResult } from "@symphony/contracts";

import type { FilePerformerProfileStoreImpl } from "./FilePerformerProfileStoreImpl.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class PerformerProfileControlProcessImpl {
  constructor(
    private readonly lane: {
      run(input: {
        executable: string;
        arguments: string[];
        environment: NodeJS.ProcessEnv;
        deadlineMs: number;
        stdin?: Uint8Array;
      }): Promise<{ stdout: string; stderr: string }>;
    },
    private readonly profiles: Pick<FilePerformerProfileStoreImpl, "codexHome">,
    private readonly options: {
      executable: string;
      environment(profileId: string): NodeJS.ProcessEnv;
      deadlineMs: number;
    },
  ) {}

  async status(profileId: string) {
    return this.#invoke({
      protocol_version: "1",
      request_id: `profile-status-${profileId}`,
      kind: "get_profile_status",
      profile_id: profileId,
    });
  }

  async startChatGptLogin(profileId: string) {
    return this.#invoke({
      protocol_version: "1",
      request_id: `profile-login-${profileId}`,
      kind: "start_chatgpt_login",
      profile_id: profileId,
    });
  }

  async setApiKey(profileId: string, secret: Uint8Array) {
    if (secret.byteLength < 1 || secret.byteLength > 16_384) {
      secret.fill(0);
      throw new Error("profile_secret_frame_invalid");
    }
    return this.#invoke(
      {
        protocol_version: "1",
        request_id: `profile-api-key-${profileId}`,
        kind: "set_api_key",
        profile_id: profileId,
        secret_frame_length: secret.byteLength,
      },
      secret,
    );
  }

  async #invoke(metadata: Record<string, JsonValue>, secret?: Uint8Array) {
    const metadataFrame = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
    const stdin = secret
      ? Buffer.concat([metadataFrame, Buffer.from(secret)])
      : metadataFrame;
    try {
      const output = await this.lane.run({
        executable: this.options.executable,
        arguments: ["--profile-control"],
        environment: {
          ...this.options.environment(String(metadata.profile_id)),
          CODEX_HOME: this.profiles.codexHome(String(metadata.profile_id)),
        },
        deadlineMs: this.options.deadlineMs,
        stdin,
      });
      const lines = output.stdout.trim().split("\n").filter(Boolean);
      if (lines.length === 0) throw new Error("profile_control_result_missing");
      const results = lines.map((line) => {
        try {
          return decodeConductorPerformerPerformerProfileControlResult(
            JSON.parse(line),
          ) as unknown as Record<string, JsonValue>;
        } catch {
          throw new Error("profile_control_result_invalid");
        }
      });
      const result = results.at(-1)!;
      if (
        result.request_id !== metadata.request_id ||
        result.profile_id !== metadata.profile_id
      ) {
        throw new Error("profile_control_correlation_mismatch");
      }
      return result;
    } finally {
      secret?.fill(0);
      stdin.fill(0);
    }
  }
}
