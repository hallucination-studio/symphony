import {
  decodeConductorPerformerPerformerTurnCommand,
  decodeConductorPerformerPerformerTurnResult,
} from "@symphony/contracts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GlobalPerformerLane } from "./GlobalPerformerLane.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export class PerformerTurnProcessImpl {
  constructor(
    private readonly lane: Pick<GlobalPerformerLane, "run">,
    private readonly options: {
      runtimeRoot: string;
      executable: string;
      environment(profileId: string): NodeJS.ProcessEnv;
      deadlineMs: number;
    },
  ) {}

  async run(input: {
    turnId: string;
    profileId: string;
    workspaceRoot: string;
    command: JsonValue;
  }): Promise<JsonValue> {
    const command = decodeConductorPerformerPerformerTurnCommand(
      input.command,
    ) as unknown as JsonValue;
    const directory = path.join(this.options.runtimeRoot, input.turnId);
    const requestPath = path.join(directory, "turn-request.json");
    const resultPath = path.join(directory, "turn-result.json");
    const eventPath = path.join(directory, "turn-events.ndjson");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rm(resultPath, { force: true });
    await writeFile(requestPath, `${JSON.stringify(command)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await this.lane.run({
        executable: this.options.executable,
        arguments: [
          "--turn-request-path",
          requestPath,
          "--turn-result-path",
          resultPath,
          "--event-path",
          eventPath,
        ],
        environment: this.options.environment(input.profileId),
        workingDirectory: input.workspaceRoot,
        deadlineMs: this.options.deadlineMs,
      });
      let value: unknown;
      try {
        value = JSON.parse(await readFile(resultPath, "utf8"));
      } catch (error) {
        if (isMissing(error)) throw new Error("performer_result_missing");
        throw new Error("performer_result_json_invalid");
      }
      try {
        return decodeConductorPerformerPerformerTurnResult(
          value as JsonValue,
        ) as unknown as JsonValue;
      } catch {
        throw new Error("performer_result_contract_invalid");
      }
    } catch (error) {
      throw new Error(sanitize(error));
    }
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function sanitize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^[a-z][a-z0-9_]{1,120}$/.test(message)) return message;
  return "performer_turn_process_failed";
}
