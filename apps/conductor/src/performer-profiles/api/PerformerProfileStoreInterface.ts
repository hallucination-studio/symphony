export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ExecutionCommandRule {
  executable: string;
  argvPrefix: string[];
}

export interface AgentExecutionPolicy {
  sandboxMode: "read_only" | "workspace_write" | "unrestricted";
  commandAllowlist: ExecutionCommandRule[];
  commandDenylist: ExecutionCommandRule[];
}

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
  executionPolicy: AgentExecutionPolicy;
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
    executionPolicy?: AgentExecutionPolicy;
    now: string;
  }): Promise<PerformerProfile>;
  update(input: {
    profileId: string;
    displayName: string;
    codexTurnSettings: PerformerProfile["codexTurnSettings"];
    executionPolicy?: AgentExecutionPolicy;
    now: string;
  }): Promise<PerformerProfile>;
  activate(
    profileId: string,
    readiness: "login-required" | "ready" | "invalid",
  ): Promise<void>;
  codexHome(profileId: string): string;
}

export function agentCommandAllowed(
  policy: AgentExecutionPolicy,
  executable: string,
  argv: string[],
): boolean {
  const matches = (rule: ExecutionCommandRule) =>
    rule.executable === executable &&
    rule.argvPrefix.every((value, index) => argv[index] === value);
  if (policy.commandDenylist.some(matches)) return false;
  return policy.commandAllowlist.length === 0 ||
    policy.commandAllowlist.some(matches);
}
