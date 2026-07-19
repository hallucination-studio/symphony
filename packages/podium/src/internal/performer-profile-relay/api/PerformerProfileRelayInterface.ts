export interface CodexTurnSettings {
  model: string;
  reasoning_effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  is_fast_mode_enabled: boolean;
}

export type ProfileRelayMetadata =
  | { kind: "get_profiles"; conductor_id: string }
  | {
      kind: "get_profile_status" | "start_chatgpt_login" | "activate_profile";
      conductor_id: string;
      profile_id: string;
    }
  | {
      kind: "create_profile";
      conductor_id: string;
      display_name: string;
      backend_kind: "codex";
      authentication_method: "chatgpt" | "api_key";
      codex_turn_settings: CodexTurnSettings;
    }
  | {
      kind: "update_profile";
      conductor_id: string;
      profile_id: string;
      display_name: string;
      codex_turn_settings: CodexTurnSettings;
    };

export interface ProfileSummary {
  profile_id: string;
  display_name: string;
  authentication_method: "chatgpt" | "api_key";
  codex_turn_settings: CodexTurnSettings;
  readiness: "login-required" | "ready" | "invalid";
  is_active: boolean;
  sanitized_account_label?: string;
  observed_at: string;
}

interface ProfileRelayError {
  code: string;
  category: string;
  sanitized_reason: string;
  retryable: boolean;
  action_required: string;
  next_action: string;
}

export type ProfileRelayResult =
  | { kind: "profiles"; profiles: ReadonlyArray<ProfileSummary> }
  | {
      kind: "profile_status" | "profile_saved" | "profile_activated";
      profile: ProfileSummary;
    }
  | { kind: "login_started"; profile_id: string }
  | { kind: "profile_relay_failed"; error: ProfileRelayError };

export interface PerformerProfileRelayInterface {
  relay(metadata: ProfileRelayMetadata): Promise<ProfileRelayResult>;
  setApiKey(input: {
    conductorId: string;
    profileId: string;
    secret: Uint8Array;
  }): Promise<ProfileRelayResult>;
}
