import { createHash } from "node:crypto";

import { CodexProcess, type CodexProcessOptions } from "../../codex-app-server/internal/CodexProcess.js";
import { CodexThread } from "../../codex-app-server/internal/CodexThread.js";
import {
  parseObservationDigest,
  type CorrelationId,
  type ObservationDigest,
  type RootIssueId,
  type RuntimeGeneration,
  type ThreadId,
} from "../../contracts/identity.js";
import {
  parseRootBootstrap,
  parseRootObservationDiff,
  type RootBootstrap,
  type RootObservationDiff,
} from "../../contracts/observation.js";
import { parseRootOutput, type RootOutput } from "../../contracts/root-interaction.js";
import type {
  RootReconcillFactoryInput,
  RootReconcillFactoryInterface,
  RootReconcillInterface,
} from "../api/RootReconcillInterface.js";
import { RootContinuityStore } from "./RootContinuityStore.js";

export interface RootTurnTransport {
  readonly threadId: ThreadId;
  turn(input: string, correlationId: CorrelationId, outputSchema: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface RootTurnTransportFactory {
  create(input: RootReconcillFactoryInput): Promise<RootTurnTransport>;
}

const stringIdentity = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const envelope = {
  schema_version: { const: 1 },
  root_id: stringIdentity,
  runtime_generation: { type: "integer", minimum: 1 },
  correlation_id: stringIdentity,
};

function variant(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: "object", properties: { ...envelope, ...properties }, required: [
    "schema_version", "root_id", "runtime_generation", "correlation_id", ...required,
  ], additionalProperties: false };
}

export const ROOT_OUTPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  oneOf: [
    variant({ kind: { const: "tool" }, tool: { const: "plan" }, cycle_issue_id: stringIdentity }, ["kind", "tool", "cycle_issue_id"]),
    variant({ kind: { const: "tool" }, tool: { const: "work" }, work_issue_id: stringIdentity }, ["kind", "tool", "work_issue_id"]),
    variant({ kind: { const: "tool" }, tool: { const: "verify" }, verify_issue_id: stringIdentity, revision: { type: "string", pattern: "^[0-9a-f]{40,64}$" } }, ["kind", "tool", "verify_issue_id", "revision"]),
    variant({ kind: { const: "decision" }, decision: { const: "StartCycle" } }, ["kind", "decision"]),
    variant({ kind: { const: "decision" }, decision: { const: "ContinueCycle" }, cycle_issue_id: stringIdentity }, ["kind", "decision", "cycle_issue_id"]),
    variant({ kind: { const: "decision" }, decision: { const: "CloseCycleAndReplan" }, cycle_issue_id: stringIdentity, reason: { type: "string", minLength: 1, maxLength: 4096 } }, ["kind", "decision", "cycle_issue_id", "reason"]),
    variant({ kind: { const: "decision" }, decision: { const: "DeliverVerifiedRevision" }, cycle_issue_id: stringIdentity, revision: { type: "string", pattern: "^[0-9a-f]{40,64}$" } }, ["kind", "decision", "cycle_issue_id", "revision"]),
    variant({ kind: { const: "decision" }, decision: { enum: ["Wait", "Stop"] }, reason: { type: "string", minLength: 1, maxLength: 4096 } }, ["kind", "decision", "reason"]),
  ],
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function bootstrapObservationDigest(input: Pick<RootBootstrap, "linear" | "git">): ObservationDigest {
  const facts = canonical({ linear: input.linear, git: input.git });
  return parseObservationDigest(`sha256:${createHash("sha256").update(facts).digest("hex")}`);
}

function prompt(kind: "RootBootstrap" | "RootObservationDiff", observation: RootBootstrap | RootObservationDiff): string {
  return JSON.stringify({
    role: "RootReconcill",
    instruction: "Choose exactly one closed RootOutput from the supplied current facts.",
    kind,
    observation,
  });
}

class BoundRootReconcill implements RootReconcillInterface {
  readonly rootId: RootIssueId;
  readonly runtimeGeneration: RuntimeGeneration;
  #acceptedDigest: ObservationDigest | null = null;
  #closed = false;
  #restartRequired = false;

  constructor(
    input: RootReconcillFactoryInput,
    private readonly transport: RootTurnTransport,
    private readonly continuity: RootContinuityStore,
  ) {
    this.rootId = input.root_id;
    this.runtimeGeneration = input.runtime_generation;
  }

  async bootstrap(input: RootBootstrap): Promise<RootOutput> {
    if (this.#closed) throw new Error("root_reconcill_closed");
    if (this.#restartRequired) throw new Error("root_restart_required");
    if (this.#acceptedDigest) throw new Error("root_already_bootstrapped");
    const parsed = parseRootBootstrap(input);
    this.#assertEnvelope(parsed.root_id, parsed.runtime_generation);
    const output = await this.#turn(prompt("RootBootstrap", parsed), parsed.correlation_id);
    const digest = bootstrapObservationDigest(parsed);
    await this.#writeAccepted({
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      thread_id: this.transport.threadId,
      accepted_observation_digest: digest,
      in_flight_correlation: null,
    });
    this.#acceptedDigest = digest;
    return output;
  }

  async advance(input: RootObservationDiff): Promise<RootOutput> {
    if (this.#closed) throw new Error("root_reconcill_closed");
    if (this.#restartRequired) throw new Error("root_restart_required");
    if (!this.#acceptedDigest) throw new Error("root_bootstrap_required");
    const parsed = parseRootObservationDiff(input);
    this.#assertEnvelope(parsed.root_id, parsed.runtime_generation);
    if (parsed.from_observation_digest !== this.#acceptedDigest) throw new Error("observation_discontinuity");
    await this.#writeAccepted({
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      thread_id: this.transport.threadId,
      accepted_observation_digest: this.#acceptedDigest,
      in_flight_correlation: parsed.correlation_id,
    });
    const output = await this.#turn(prompt("RootObservationDiff", parsed), parsed.correlation_id);
    await this.#writeAccepted({
      schema_version: 1,
      root_id: this.rootId,
      runtime_generation: this.runtimeGeneration,
      thread_id: this.transport.threadId,
      accepted_observation_digest: parsed.to_observation_digest,
      in_flight_correlation: null,
    });
    this.#acceptedDigest = parsed.to_observation_digest;
    return output;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.transport.close();
  }

  async #turn(input: string, correlationId: CorrelationId): Promise<RootOutput> {
    try {
      const output = parseRootOutput(await this.transport.turn(input, correlationId, ROOT_OUTPUT_SCHEMA));
      if (output.root_id !== this.rootId) throw new Error("root_output_identity_mismatch");
      if (output.runtime_generation !== this.runtimeGeneration) throw new Error("stale_generation");
      if (output.correlation_id !== correlationId) throw new Error("root_output_correlation_mismatch");
      return output;
    } catch {
      this.#restartRequired = true;
      throw new Error("root_restart_required");
    }
  }

  #assertEnvelope(rootId: RootIssueId, generation: RuntimeGeneration): void {
    if (rootId !== this.rootId) throw new Error("root_identity_mismatch");
    if (generation !== this.runtimeGeneration) throw new Error("stale_generation");
  }

  async #writeAccepted(state: Parameters<RootContinuityStore["write"]>[0]): Promise<void> {
    try {
      await this.continuity.write(state);
    } catch {
      this.#restartRequired = true;
      throw new Error("root_restart_required");
    }
  }
}

export class RootReconcillFactory implements RootReconcillFactoryInterface {
  constructor(private readonly transports: RootTurnTransportFactory) {}

  async create(input: RootReconcillFactoryInput): Promise<RootReconcillInterface> {
    const continuity = new RootContinuityStore(input.root_home);
    let previous: Awaited<ReturnType<RootContinuityStore["load"]>> | null = null;
    try { previous = await continuity.load(); } catch (error) {
      if (!(error instanceof Error) || error.message !== "root_continuity_unavailable") throw error;
    }
    if (previous) {
      if (previous.root_id !== input.root_id) throw new Error("root_home_owner_mismatch");
      if (input.runtime_generation !== previous.runtime_generation + 1) throw new Error("invalid_restart_generation");
    } else if (input.runtime_generation !== 1) {
      throw new Error("invalid_initial_generation");
    }
    const transport = await this.transports.create(input);
    return new BoundRootReconcill(input, transport, continuity);
  }
}

export class CodexRootTurnTransportFactory implements RootTurnTransportFactory {
  constructor(private readonly options: Omit<CodexProcessOptions, "codexHome" | "rootId" | "runtimeGeneration">) {}

  async create(input: RootReconcillFactoryInput): Promise<RootTurnTransport> {
    const process = await CodexProcess.start({
      ...this.options,
      codexHome: input.root_home,
      rootId: input.root_id,
      runtimeGeneration: input.runtime_generation,
    });
    try {
      const thread = await CodexThread.create(process, {
        cwd: input.root_home,
        tools: [],
        correlationId: `${input.root_id}:thread:${input.runtime_generation}` as CorrelationId,
        access: { kind: "read_only" },
      });
      return {
        threadId: thread.threadId,
        async turn(text, correlationId, outputSchema) {
          const result = await thread.turn(text, correlationId, 120_000, outputSchema);
          if (result.status !== "completed") throw new Error(result.status === "interrupted" ? "codex_turn_canceled" : "codex_turn_failed");
          return result.output;
        },
        async close() {
          thread.close();
          await process.shutdown();
        },
      };
    } catch (error) {
      await process.shutdown();
      throw error;
    }
  }
}
