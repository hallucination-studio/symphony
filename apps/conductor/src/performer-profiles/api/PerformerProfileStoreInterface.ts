export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface PerformerProfile {
  profileId: string;
  displayName: string;
  backendKind: "codex";
  authenticationMethod: "chatgpt" | "api_key";
  codexTurnSettings: {
    model: string;
    reasoningEffort: ReasoningEffort;
    isFastModeEnabled: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PerformerProfileStoreInterface {
  list(): Promise<{ profiles: PerformerProfile[]; activeProfileId?: string }>;
  create(input: {
    profileId: string;
    displayName: string;
    backendKind: "codex";
    authenticationMethod: "chatgpt" | "api_key";
    codexTurnSettings: PerformerProfile["codexTurnSettings"];
    now: string;
  }): Promise<PerformerProfile>;
  update(input: {
    profileId: string;
    displayName: string;
    codexTurnSettings: PerformerProfile["codexTurnSettings"];
    now: string;
  }): Promise<PerformerProfile>;
  activate(
    profileId: string,
    readiness: "login-required" | "ready" | "invalid",
  ): Promise<void>;
  codexHome(profileId: string): string;
}
