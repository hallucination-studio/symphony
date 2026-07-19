import {
  decodeConductorPerformerPerformerTurnCommand,
  decodeConductorPerformerPerformerTurnResult,
  type JsonValue,
} from "@symphony/contracts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { GlobalPerformerLane } from "./GlobalPerformerLane.js";
import {
  PerformerEventStreamDecoder,
  type DecodedPerformerTurnEvent,
  type PerformerEventStreamViolation,
} from "./PerformerEventStreamDecoder.js";

type JsonRecord = { [key: string]: JsonValue };

export class PerformerTurnProcessImpl {
  #sequenceState?: { turnId: string; nextSequence: number };

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
    onEvent?(event: DecodedPerformerTurnEvent): void;
    onEventViolation?(violation: PerformerEventStreamViolation): void;
  }): Promise<{ result: JsonValue }> {
    const command = decodeConductorPerformerPerformerTurnCommand(
      input.command,
    ) as unknown as JsonRecord;
    const directory = path.join(this.options.runtimeRoot, input.turnId);
    const requestPath = path.join(directory, "turn-request.json");
    const resultPath = path.join(directory, "turn-result.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rm(resultPath, { force: true });
    await writeFile(requestPath, `${JSON.stringify(command)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const sequenceStart = this.#sequenceState?.turnId === input.turnId
      ? this.#sequenceState.nextSequence
      : 0;
    this.#sequenceState = { turnId: input.turnId, nextSequence: sequenceStart };
    const stream = new PerformerEventStreamDecoder({
      turnId: command.turn_id as string,
      rootIssueId: command.root_issue_id as string,
      ...(command.work_issue_id === undefined
        ? {}
        : { workIssueId: command.work_issue_id as string }),
      sequenceStart,
      onEvent: (event) => {
        this.#sequenceState = {
          turnId: input.turnId,
          nextSequence: (event.sequence as number) + 1,
        };
        input.onEvent?.(event);
      },
      onViolation: (violation) => input.onEventViolation?.(violation),
    });

    try {
      let processError: unknown;
      try {
        await this.lane.run({
          executable: this.options.executable,
          arguments: [
            "--turn-request-path",
            requestPath,
            "--turn-result-path",
            resultPath,
            "--event-sequence-start",
            String(sequenceStart),
          ],
          environment: this.options.environment(input.profileId),
          workingDirectory: input.workspaceRoot,
          deadlineMs: this.options.deadlineMs,
          onStdout: (chunk) => stream.write(chunk),
        });
      } catch (error) {
        processError = error;
      } finally {
        stream.end();
      }
      if (processError !== undefined) throw processError;

      let value: unknown;
      try {
        value = JSON.parse(await readFile(resultPath, "utf8"));
      } catch (error) {
        if (isMissing(error)) throw new Error("performer_result_missing");
        throw new Error("performer_result_json_invalid");
      }
      try {
        return {
          result: decodeConductorPerformerPerformerTurnResult(
            value as JsonValue,
          ) as unknown as JsonValue,
        };
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
  const code = /^(performer_[a-z0-9_]{1,110})(?:$|[ =])/u.exec(message)?.[1];
  return code ?? "performer_turn_process_failed";
}
