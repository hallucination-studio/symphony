import type { JsonValue } from "@symphony/contracts";

export interface PerformerStageClientRunInput {
  envelope: JsonValue;
  workspaceRoot: string;
  onEvent?(event: Readonly<Record<string, JsonValue>>): void;
  signal?: AbortSignal;
}

export interface PerformerStageClientRunResult {
  result: JsonValue;
}

export interface PerformerStageClientInterface {
  runStage(input: PerformerStageClientRunInput): Promise<PerformerStageClientRunResult>;
  cancelAndReap(): Promise<void>;
}
