import {
  decodeConductorPerformerOpenRootConversationCommand,
  decodeConductorPerformerOpenRootConversationResult,
  decodeConductorPerformerFirstRootTurnStart,
  decodeConductorPerformerRootTurnCommand,
  decodeConductorPerformerRootTurnEvent,
  decodeConductorPerformerRootTurnResult,
  type JsonValue,
} from "@symphony/contracts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";

import type {
  PerformerProcessInterface,
  PerformerRootTurnInput,
} from "../api/PerformerProcessInterface.js";
import type {
  GlobalPerformerLane,
  PerformerInvocationControl,
} from "./GlobalPerformerLane.js";
import {
  agentCommandCliMap,
  dispatchAgentCommand,
  parseAgentCommand,
} from "../../agent-symphony-harness/internal/AgentCommandRegistry.js";

type JsonRecord = { [key: string]: JsonValue };
const MAX_EVENT_BYTES = 1_048_576;
const FIRST_TURN_HANDOFF_DEADLINE_MS = 300_000;

interface PendingBootstrap {
  profileId: string;
  performerId: string;
  control: PerformerInvocationControl;
  process: Promise<unknown>;
  setOnStdout(handler: (chunk: Uint8Array) => void): void;
}

export class SubprocessPerformerProcessImpl implements PerformerProcessInterface {
  readonly #activeBrokers = new Set<BrokerBridge>();
  #pendingBootstrap: PendingBootstrap | undefined;
  constructor(
    private readonly lane: Pick<GlobalPerformerLane, "run" | "cancelAndReap">,
    private readonly options: {
      runtimeRoot: string;
      executable: string;
      environment(profileId: string): NodeJS.ProcessEnv;
      startupDeadlineMs: number;
      cancellationGraceMs: number;
    },
  ) {}

  async openRootConversation(input: { profileId: string; command: JsonValue }) {
    const command = decodeConductorPerformerOpenRootConversationCommand(
      input.command,
    ) as unknown as JsonRecord;
    const directory = path.join(
      this.options.runtimeRoot,
      `open-${command.request_id as string}`,
    );
    const requestPath = path.join(directory, "conversation-request.json");
    const resultPath = path.join(directory, "conversation-result.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rm(resultPath, { force: true });
    await writeFile(requestPath, `${JSON.stringify(command)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (this.#pendingBootstrap) {
      this.#pendingBootstrap.control.closeStdin();
      await this.#pendingBootstrap.process.catch(() => undefined);
      this.#pendingBootstrap = undefined;
    }
    let control: PerformerInvocationControl | undefined;
    let processDone = false;
    let processError: unknown;
    let onStdout: (chunk: Uint8Array) => void = () => undefined;
    const process = this.lane.run({
      executable: this.options.executable,
      arguments: [
        "--open-conversation-request-path", requestPath,
        "--open-conversation-result-path", resultPath,
      ],
      environment: bootstrapEnvironment(
        this.options.environment(input.profileId),
        this.options.executable,
      ),
      deadlineMs: this.options.startupDeadlineMs,
      startupDeadlineMs: this.options.startupDeadlineMs,
      extraPipeCount: 2,
      onStarted(value) { control = value; },
      onStdout(chunk) { onStdout(chunk); },
    }).then(
      (value) => { processDone = true; return value; },
      (error) => { processDone = true; processError = error; throw error; },
    );
    // The successful bootstrap deliberately remains alive for the first Turn.
    process.catch(() => undefined);
    const result = await waitForJson(
      resultPath,
      "performer_conversation_result",
      () => ({ done: processDone, error: processError }),
      this.options.startupDeadlineMs,
    );
    const decoded = decodeConductorPerformerOpenRootConversationResult(
      result as JsonValue,
    ) as unknown as JsonRecord;
    for (const field of ["protocol_version", "request_id", "performer_profile_id"] as const) {
      if (decoded[field] !== command[field]) {
        throw new Error("performer_conversation_result_correlation_invalid");
      }
    }
    if (typeof decoded.performer_id === "string") {
      if (!control || processDone) {
        throw processError ?? new Error("performer_bootstrap_process_exited");
      }
      control.markReady?.(FIRST_TURN_HANDOFF_DEADLINE_MS);
      this.#pendingBootstrap = {
        profileId: input.profileId,
        performerId: decoded.performer_id,
        control,
        process,
        setOnStdout(handler) { onStdout = handler; },
      };
    } else {
      await process;
    }
    return { result: decoded as JsonValue };
  }

  async runRootTurn(input: PerformerRootTurnInput) {
    const command = decodeConductorPerformerRootTurnCommand(
      input.command,
    ) as unknown as JsonRecord;
    const context = command.root_context as JsonRecord;
    const contextBytes = Buffer.byteLength(context.json as string)
      + Buffer.byteLength(context.markdown as string);
    const limits = command.turn_limits as JsonRecord;
    if (contextBytes > (limits.max_context_bytes as number)) {
      throw new Error("performer_context_bytes_exceeded");
    }

    const directory = path.join(this.options.runtimeRoot, command.turn_id as string);
    const resultPath = path.join(directory, "root-turn-result.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rm(resultPath, { force: true });
    let control: PerformerInvocationControl | undefined;
    let broker: BrokerBridge | undefined;
    let contextSent = false;
    const events = new RootEventDecoder(command, (event) => {
      if (event.body && (event.body as JsonRecord).kind === "protocol_ready") {
        if (!contextSent && control) {
          contextSent = true;
          control.markReady?.(limits.max_wall_time_ms as number);
          control.writeStdin(Buffer.from(JSON.stringify(command)));
          control.closeStdin();
        }
      }
      input.onEvent?.(event);
    }, (code) => input.onEventViolation?.(code));

    try {
      const pending = this.#pendingBootstrap;
      if (pending) {
        this.#pendingBootstrap = undefined;
        if (pending.profileId !== input.profileId
          || pending.performerId !== command.performer_id) {
          pending.control.closeStdin();
          await pending.process.catch(() => undefined);
          throw new Error("performer_bootstrap_correlation_invalid");
        }
        control = pending.control;
        pending.setOnStdout((chunk) => events.write(chunk));
        if (control.extraStreams.length !== 2) {
          control.closeStdin();
          await pending.process.catch(() => undefined);
          throw new Error("performer_process_stream_missing");
        }
        broker = new BrokerBridge(
          control.extraStreams[0]!, control.extraStreams[1]!,
          input.broker.execute.bind(input.broker),
        );
        this.#activeBrokers.add(broker);
        const start = decodeConductorPerformerFirstRootTurnStart({
          ...Object.fromEntries(correlationFields.map((field) => [field, command[field]])),
          result_path: resultPath,
        } as JsonValue);
        control.markReady?.(this.options.startupDeadlineMs);
        control.writeStdin(Buffer.from(`${JSON.stringify(start)}\n`));
        await pending.process;
      } else {
        await this.lane.run({
          executable: this.options.executable,
          arguments: correlationArguments(command, resultPath),
          environment: turnEnvironment(
            this.options.environment(input.profileId),
            this.options.executable,
            command,
          ),
          workingDirectory: input.workspaceRoot,
          deadlineMs: limits.max_wall_time_ms as number,
          startupDeadlineMs: this.options.startupDeadlineMs,
          extraPipeCount: 2,
          onStarted: (value) => {
            control = value;
            if (value.extraStreams.length === 2) {
              broker = new BrokerBridge(
                value.extraStreams[0]!,
                value.extraStreams[1]!,
                input.broker.execute.bind(input.broker),
              );
              this.#activeBrokers.add(broker);
            }
          },
          onStdout(chunk) { events.write(chunk); },
        });
      }
    } finally {
      events.end();
      broker?.close();
      if (broker) this.#activeBrokers.delete(broker);
    }
    if (!contextSent) throw new Error("performer_protocol_not_ready");
    const value = await readJson(resultPath, "performer_result");
    let result: JsonRecord;
    try {
      result = decodeConductorPerformerRootTurnResult(
        value as JsonValue,
      ) as unknown as JsonRecord;
    } catch {
      throw new Error("performer_result_contract_invalid");
    }
    for (const field of correlationFields) {
      if (result[field] !== command[field]) {
        throw new Error("performer_result_correlation_invalid");
      }
    }
    const observed = broker?.usage() ?? { brokerCalls: 0, mutations: 0 };
    const corrected = decodeConductorPerformerRootTurnResult({
      ...result,
      turn_usage: {
        ...(result.turn_usage as JsonRecord),
        broker_calls: observed.brokerCalls,
        mutations: observed.mutations,
      },
    } as JsonValue);
    return { result: corrected as JsonValue };
  }

  async abandonRootConversation(performerId: string) {
    const pending = this.#pendingBootstrap;
    if (!pending || pending.performerId !== performerId) return;
    this.#pendingBootstrap = undefined;
    pending.control.closeStdin();
    await pending.process.catch(() => undefined);
  }

  cancelAndReap() {
    this.#pendingBootstrap = undefined;
    for (const broker of this.#activeBrokers) broker.cancel();
    return this.lane.cancelAndReap(this.options.cancellationGraceMs);
  }
}

async function waitForJson(
  file: string,
  prefix: string,
  processState: () => { done: boolean; error: unknown },
  deadlineMs: number,
): Promise<unknown> {
  const expiresAt = Date.now() + deadlineMs;
  while (Date.now() < expiresAt) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw new Error(`${prefix}_json_invalid`);
      }
    }
    const state = processState();
    if (state.done) throw state.error ?? new Error(`${prefix}_missing`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${prefix}_timeout`);
}

function turnEnvironment(
  base: NodeJS.ProcessEnv,
  executable: string,
  command: JsonRecord,
): NodeJS.ProcessEnv {
  const executableDirectory = path.dirname(path.resolve(executable));
  const searchPath = base.PATH
    ? `${executableDirectory}${path.delimiter}${base.PATH}`
    : `${executableDirectory}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  return {
    ...base,
    PATH: searchPath,
    SYMPHONY_AGENT_COMMAND_CATALOG: JSON.stringify(agentCommandCliMap()),
    SYMPHONY_TURN_ID: command.turn_id as string,
    SYMPHONY_ROOT_ISSUE_ID: command.root_issue_id as string,
    SYMPHONY_PERFORMER_ID: command.performer_id as string,
  };
}

function bootstrapEnvironment(
  base: NodeJS.ProcessEnv,
  executable: string,
): NodeJS.ProcessEnv {
  const executableDirectory = path.dirname(path.resolve(executable));
  return {
    ...base,
    PATH: base.PATH
      ? `${executableDirectory}${path.delimiter}${base.PATH}`
      : `${executableDirectory}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    SYMPHONY_AGENT_COMMAND_CATALOG: JSON.stringify(agentCommandCliMap()),
  };
}

const correlationFields = [
  "protocol_version", "turn_id", "root_issue_id", "performer_profile_id",
  "performer_id", "context_digest",
] as const;

function correlationArguments(command: JsonRecord, resultPath: string): string[] {
  return [
    "--root-turn-result-path", resultPath,
    "--turn-id", command.turn_id as string,
    "--root-issue-id", command.root_issue_id as string,
    "--performer-profile-id", command.performer_profile_id as string,
    "--performer-id", command.performer_id as string,
    "--context-digest", command.context_digest as string,
  ];
}

class RootEventDecoder {
  #buffer = Buffer.alloc(0);
  #bytes = 0;
  #nextSequence = 0;
  #stopped = false;

  constructor(
    private readonly command: JsonRecord,
    private readonly onEvent: (event: JsonRecord) => void,
    private readonly onViolation: (code: string) => void,
  ) {}

  write(chunk: Uint8Array) {
    if (this.#stopped) return;
    this.#bytes += chunk.byteLength;
    if (this.#bytes > MAX_EVENT_BYTES) {
      this.onViolation("performer_event_stream_total_bytes_exceeded");
      this.#stopped = true;
      this.#buffer = Buffer.alloc(0);
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = this.#buffer.indexOf(0x0a)) >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#decode(frame);
    }
  }

  end() {
    if (this.#buffer.byteLength > 0) {
      this.onViolation("performer_event_stream_frame_incomplete");
    }
  }

  #decode(frame: Uint8Array) {
    let event: JsonRecord;
    try {
      event = decodeConductorPerformerRootTurnEvent(
        JSON.parse(Buffer.from(frame).toString("utf8")) as JsonValue,
      ) as unknown as JsonRecord;
    } catch {
      this.onViolation("performer_event_contract_invalid");
      return;
    }
    if (
      correlationFields.some((field) => event[field] !== this.command[field])
      || event.sequence !== this.#nextSequence
    ) {
      this.onViolation("performer_event_correlation_invalid");
      return;
    }
    this.#nextSequence += 1;
    this.onEvent(event);
  }
}

async function readJson(file: string, prefix: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${prefix}_missing`);
    }
    throw new Error(`${prefix}_json_invalid`);
  }
}

class BrokerBridge {
  #buffer = Buffer.alloc(0);
  #chain = Promise.resolve();
  #accepting = true;
  #totalBytes = 0;
  #brokerCalls = 0;
  #mutations = 0;

  constructor(
    private readonly requests: Duplex,
    private readonly responses: Duplex,
    private readonly execute: (value: unknown) => Promise<JsonValue>,
  ) {
    requests.on("data", (chunk: Buffer) => this.#write(chunk));
  }

  cancel() { this.#accepting = false; }

  usage() {
    return { brokerCalls: this.#brokerCalls, mutations: this.#mutations };
  }

  close() {
    this.#accepting = false;
    this.requests.destroy();
    this.responses.end();
  }

  #write(chunk: Uint8Array) {
    this.#totalBytes += chunk.byteLength;
    if (this.#totalBytes > 1_048_576
      || this.#buffer.byteLength + chunk.byteLength > 65_536) {
      this.cancel();
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    let newline: number;
    while ((newline = this.#buffer.indexOf(0x0a)) >= 0) {
      const frame = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      this.#chain = this.#chain.then(() => this.#dispatch(frame)).catch(() => undefined);
    }
  }

  async #dispatch(frame: Uint8Array) {
    let request: unknown;
    try {
      request = JSON.parse(Buffer.from(frame).toString("utf8"));
    } catch {
      return;
    }
    this.#brokerCalls += 1;
    try {
      if (dispatchAgentCommand(parseAgentCommand(request)).mutation) {
        this.#mutations += 1;
      }
    } catch {
      // The scoped broker produces the closed rejection for malformed requests.
    }
    let result: JsonValue;
    try {
      result = this.#accepting
        ? await this.execute(request)
        : canceledCommandResult(request);
    } catch {
      result = failedCommandResult(request);
    }
    if (!this.responses.writable) return;
    this.responses.write(`${JSON.stringify(result)}\n`);
  }
}

function failedCommandResult(value: unknown): JsonValue {
  return {
    ...commandCorrelation(value),
    status: "failed",
    problem: {
      code: "command_broker_failed",
      sanitized_reason: "The Root Turn command broker failed.",
      retryable: true,
      next_steps: ["Retry after fresh Root read-back."],
    },
  };
}

function canceledCommandResult(value: unknown): JsonValue {
  return {
    ...commandCorrelation(value),
    status: "rejected",
    problem: {
      code: "command_channel_canceled",
      sanitized_reason: "The Root Turn command channel is canceled.",
      retryable: false,
      next_steps: ["Wait for the Root to be scheduled again."],
    },
  };
}

function commandCorrelation(value: unknown): Record<string, JsonValue> {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    protocol_version: typeof source.protocol_version === "string"
      ? source.protocol_version : "1",
    request_id: typeof source.request_id === "string" ? source.request_id : "invalid",
    turn_id: typeof source.turn_id === "string" ? source.turn_id : "invalid",
    root_issue_id: typeof source.root_issue_id === "string"
      ? source.root_issue_id : "invalid",
    performer_id: typeof source.performer_id === "string"
      ? source.performer_id : "invalid",
  };
}
