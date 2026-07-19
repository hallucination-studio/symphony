import { randomUUID } from "node:crypto";

import type {
  PerformerProfile,
  PerformerProfileStoreInterface,
} from "../api/PerformerProfileStoreInterface.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type Body = { [key: string]: JsonValue } & { kind: string };
type Readiness = "login-required" | "ready" | "invalid";

interface ProfileControl {
  status(profileId: string): Promise<Record<string, JsonValue>>;
  startChatGptLogin(profileId: string): Promise<Record<string, JsonValue>>;
  setApiKey(
    profileId: string,
    secret: Uint8Array,
  ): Promise<Record<string, JsonValue>>;
}

export class ConductorProfileRelayHandler {
  constructor(
    private readonly conductorId: string,
    private readonly profiles: PerformerProfileStoreInterface,
    private readonly control: ProfileControl,
    private readonly now: () => string,
    private readonly createId: () => string = randomUUID,
  ) {}

  async handleRequest(bodyValue: JsonValue, secret?: Uint8Array): Promise<JsonValue> {
    const body = record(bodyValue);
    if (body.conductor_id !== this.conductorId) {
      throw new Error("profile_conductor_mismatch");
    }
    switch (body.kind) {
      case "get_profiles":
        return this.#list();
      case "get_profile_status":
        return {
          kind: "profile_status",
          profile: await this.#summary(required(body.profile_id)),
        };
      case "create_profile": {
        const profile = await this.profiles.create({
          profileId: this.createId(),
          displayName: required(body.display_name),
          backendKind: "codex",
          authenticationMethod: authentication(body.authentication_method),
          codexTurnSettings: settings(body.codex_turn_settings),
          now: this.now(),
        });
        return {
          kind: "profile_saved",
          profile: await this.#summary(profile.profileId),
        };
      }
      case "update_profile": {
        const profile = await this.profiles.update({
          profileId: required(body.profile_id),
          displayName: required(body.display_name),
          codexTurnSettings: settings(body.codex_turn_settings),
          now: this.now(),
        });
        return {
          kind: "profile_saved",
          profile: await this.#summary(profile.profileId),
        };
      }
      case "start_chatgpt_login": {
        const profileId = required(body.profile_id);
        await this.control.startChatGptLogin(profileId);
        return { kind: "login_started", profile_id: profileId };
      }
      case "set_api_key": {
        const profileId = required(body.profile_id);
        if (!secret || secret.byteLength !== body.secret_frame_length) {
          secret?.fill(0);
          throw new Error("profile_secret_frame_invalid");
        }
        await this.control.setApiKey(profileId, secret);
        return {
          kind: "profile_status",
          profile: await this.#summary(profileId),
        };
      }
      case "activate_profile": {
        const profileId = required(body.profile_id);
        const readiness = await this.#readiness(profileId);
        await this.profiles.activate(profileId, readiness);
        return {
          kind: "profile_activated",
          profile: await this.#summary(profileId),
        };
      }
      default:
        throw new Error("profile_relay_request_unsupported");
    }
  }

  async #list(): Promise<JsonValue> {
    const file = await this.profiles.list();
    return {
      kind: "profiles",
      profiles: await Promise.all(
        file.profiles.map((profile) =>
          this.#summary(profile.profileId, profile, file.activeProfileId),
        ),
      ),
    };
  }

  async #summary(
    profileId: string,
    knownProfile?: PerformerProfile,
    knownActiveProfileId?: string,
  ): Promise<JsonValue> {
    const file = knownProfile ? undefined : await this.profiles.list();
    const profile =
      knownProfile ??
      file?.profiles.find(({ profileId: candidate }) => candidate === profileId);
    if (!profile) throw new Error("profile_not_found");
    const status = await this.control.status(profileId);
    const readiness = parseReadiness(status.readiness);
    return {
      profile_id: profile.profileId,
      display_name: profile.displayName,
      authentication_method: profile.authenticationMethod,
      codex_turn_settings: {
        model: profile.codexTurnSettings.model,
        reasoning_effort: profile.codexTurnSettings.reasoningEffort,
        is_fast_mode_enabled: profile.codexTurnSettings.isFastModeEnabled,
      },
      readiness,
      is_active:
        (knownActiveProfileId ?? file?.activeProfileId) === profile.profileId,
      ...(typeof status.sanitized_account_label === "string"
        ? { sanitized_account_label: status.sanitized_account_label }
        : {}),
      observed_at: this.now(),
    };
  }

  async #readiness(profileId: string): Promise<Readiness> {
    return parseReadiness((await this.control.status(profileId)).readiness);
  }
}

function record(value: JsonValue): Body {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("profile_relay_request_invalid");
  }
  return value as Body;
}

function required(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw new Error("profile_relay_field_invalid");
  return value;
}

function authentication(value: JsonValue | undefined): "chatgpt" | "api_key" {
  if (value !== "chatgpt" && value !== "api_key") {
    throw new Error("profile_authentication_invalid");
  }
  return value;
}

function settings(
  value: JsonValue | undefined,
): PerformerProfile["codexTurnSettings"] {
  const input = record(value ?? null);
  const effort = required(input.reasoning_effort);
  if (
    !["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort) ||
    typeof input.is_fast_mode_enabled !== "boolean"
  ) {
    throw new Error("profile_settings_invalid");
  }
  return {
    model: required(input.model),
    reasoningEffort: effort as PerformerProfile["codexTurnSettings"]["reasoningEffort"],
    isFastModeEnabled: input.is_fast_mode_enabled,
  };
}

function parseReadiness(value: JsonValue | undefined): Readiness {
  if (
    value !== "login-required" &&
    value !== "ready" &&
    value !== "invalid"
  ) {
    throw new Error("profile_status_invalid");
  }
  return value;
}
