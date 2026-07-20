import type { JsonValue } from "@symphony/contracts";

export interface PerformerCommandBroker {
  execute(value: unknown): Promise<JsonValue>;
}

export interface PerformerRootTurnInput {
  profileId: string;
  workspaceRoot: string;
  command: JsonValue;
  broker: PerformerCommandBroker;
  onEvent?(event: Readonly<Record<string, JsonValue>>): void;
  onEventViolation?(code: string): void;
}

export interface PerformerProcessInterface {
  openRootConversation(input: {
    profileId: string;
    command: JsonValue;
    workspaceRoot: string;
  }): Promise<{ result: JsonValue }>;
  abandonRootConversation(performerId: string): Promise<void>;
  runRootTurn(input: PerformerRootTurnInput): Promise<{ result: JsonValue }>;
  cancelAndReap(): Promise<void>;
}
