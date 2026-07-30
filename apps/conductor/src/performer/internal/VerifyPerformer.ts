import path from "node:path";
import { realpath } from "node:fs/promises";

import type { CodexSpawner } from "../../codex-app-server/internal/CodexProcess.js";
import { CodexProcess } from "../../codex-app-server/internal/CodexProcess.js";
import { CodexThread } from "../../codex-app-server/internal/CodexThread.js";
import { bindDynamicTools, type DynamicToolBinding } from "../../codex-app-server/internal/DynamicToolBridge.js";
import type { RootIssueId } from "../../contracts/identity.js";
import type { VerifyHandoff, VerifyRequest } from "../../contracts/stage-interaction.js";
import { parseStageHandoff } from "../../contracts/stage-interaction.js";
import { StageTurnCanceledError } from "../api/StagePerformerInterface.js";

export interface VerifyTurnResult {
  readonly status: "completed" | "interrupted" | "failed";
  readonly output?: unknown;
}

export interface VerifySession {
  turn(input: string, outputSchema: Readonly<Record<string, unknown>>): Promise<VerifyTurnResult>;
  close(): Promise<void>;
}

export interface VerifySessionFactory {
  start(request: VerifyRequest): Promise<VerifySession>;
}

const VERIFY_HANDOFF_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schema_version: { const: 1 },
    root_id: { type: "string" },
    runtime_generation: { type: "integer", minimum: 1 },
    correlation_id: { type: "string" },
    cycle_issue_id: { type: "string" },
    role: { const: "verify" },
    verify_issue_id: { type: "string" },
    revision: { type: "string", pattern: "^[0-9a-f]{40,64}$" },
    conclusion: { enum: ["passed", "failed", "inconclusive"] },
  },
  required: [
    "schema_version", "root_id", "runtime_generation", "correlation_id", "cycle_issue_id",
    "role", "verify_issue_id", "revision", "conclusion",
  ],
  additionalProperties: false,
} as const);

function verifyPrompt(request: VerifyRequest): string {
  return [
    "You are the isolated Symphony Verify role operating in a read-only worktree.",
    `For Root ${request.root_id}, Cycle ${request.cycle_issue_id}, verify only immutable revision ${request.revision}.`,
    "Inspect that exact revision and run the relevant verification checks. You must not modify or repair code.",
    `Call linear_complete_verify exactly once to update and read back only Verify Issue ${request.verify_issue_id}.`,
    "Set it Done only for passed; set it Failed for failed or inconclusive.",
    "Do not access or expose secrets. Return no prose and return only the requested VerifyHandoff object.",
    `Set schema_version=1, root_id=${request.root_id}, runtime_generation=${request.runtime_generation},`,
    `correlation_id=${request.correlation_id}, cycle_issue_id=${request.cycle_issue_id}, role=verify,`,
    `verify_issue_id=${request.verify_issue_id}, revision=${request.revision}.`,
  ].join("\n");
}

export class VerifyPerformer {
  constructor(private readonly sessions: VerifySessionFactory) {}

  async executeVerify(request: VerifyRequest): Promise<VerifyHandoff> {
    const session = await this.sessions.start(request);
    try {
      const result = await session.turn(verifyPrompt(request), VERIFY_HANDOFF_SCHEMA);
      if (result.status === "interrupted") throw new StageTurnCanceledError();
      if (result.status !== "completed") throw new Error("verify_turn_not_completed");
      const handoff = parseStageHandoff(result.output);
      if (
        handoff.role !== "verify"
        || handoff.root_id !== request.root_id
        || handoff.runtime_generation !== request.runtime_generation
        || handoff.correlation_id !== request.correlation_id
        || handoff.cycle_issue_id !== request.cycle_issue_id
        || handoff.verify_issue_id !== request.verify_issue_id
        || handoff.revision !== request.revision
      ) throw new Error("verify_handoff_identity_mismatch");
      return handoff;
    } finally {
      await session.close();
    }
  }
}

export interface CodexVerifySessionOptions {
  readonly executable: string;
  readonly performerHome: string;
  readonly worktreePath: (rootId: RootIssueId) => Promise<string>;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly spawner?: CodexSpawner;
  readonly bindings?: (request: VerifyRequest) => readonly DynamicToolBinding[];
}

export class CodexVerifySessionFactory implements VerifySessionFactory {
  constructor(private readonly options: CodexVerifySessionOptions) {}

  async start(request: VerifyRequest): Promise<VerifySession> {
    const configuredPath = await this.options.worktreePath(request.root_id);
    if (!path.isAbsolute(configuredPath)) throw new Error("worktree_path_not_absolute");
    const worktreePath = await realpath(configuredPath);
    const process = await CodexProcess.start({
      executable: this.options.executable,
      codexHome: this.options.performerHome,
      rootId: request.root_id,
      runtimeGeneration: request.runtime_generation,
      startupTimeoutMs: this.options.startupTimeoutMs,
      requestTimeoutMs: this.options.requestTimeoutMs,
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
      apiKey: this.options.apiKey,
      baseUrl: this.options.baseUrl,
      model: this.options.model,
    }, this.options.spawner);
    let thread: CodexThread;
    const bindings = this.options.bindings?.(request) ?? [];
    try {
      thread = await CodexThread.create(process, {
        cwd: worktreePath,
        tools: bindings.map(({ spec }) => spec),
        correlationId: request.correlation_id,
        access: { kind: "read_only" },
      });
    } catch (error) {
      await process.shutdown();
      throw error;
    }
    const unbind = bindDynamicTools(process, thread.threadId, bindings);
    let closed = false;
    return {
      turn: async (input, outputSchema) => {
        const result = await thread.turn(input, request.correlation_id, this.options.turnTimeoutMs, { ...outputSchema });
        return { status: result.status, ...(result.output === undefined ? {} : { output: result.output }) };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        unbind();
        thread.close();
        await process.shutdown();
      },
    };
  }
}
