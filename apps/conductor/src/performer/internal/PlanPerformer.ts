import type { CodexSpawner } from "../../codex-app-server/internal/CodexProcess.js";
import { CodexProcess } from "../../codex-app-server/internal/CodexProcess.js";
import { CodexThread } from "../../codex-app-server/internal/CodexThread.js";
import type { PlanHandoff, PlanRequest } from "../../contracts/stage-interaction.js";
import { parseStageHandoff } from "../../contracts/stage-interaction.js";

export interface PlanTurnResult {
  readonly status: "completed" | "interrupted" | "failed";
  readonly output?: unknown;
}

export interface PlanSession {
  turn(input: string, outputSchema: Readonly<Record<string, unknown>>): Promise<PlanTurnResult>;
  close(): Promise<void>;
}

export interface PlanSessionFactory {
  start(request: PlanRequest): Promise<PlanSession>;
}

const PLAN_HANDOFF_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schema_version: { const: 1 },
    root_id: { type: "string" },
    runtime_generation: { type: "integer", minimum: 1 },
    correlation_id: { type: "string" },
    cycle_issue_id: { type: "string" },
    role: { const: "plan" },
    plan_issue_id: { type: "string" },
    work_issue_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string" } },
    verify_issue_id: { type: "string" },
    outcome: { enum: ["completed", "failed", "canceled"] },
  },
  required: [
    "schema_version", "root_id", "runtime_generation", "correlation_id", "cycle_issue_id",
    "role", "plan_issue_id", "work_issue_ids", "verify_issue_id", "outcome",
  ],
  additionalProperties: false,
} as const);

function planPrompt(request: PlanRequest): string {
  return [
    "You are the isolated Symphony Plan role.",
    `Plan Root ${request.root_id} in Cycle ${request.cycle_issue_id}.`,
    "Use the installed Linear skill to create and read back exactly one Done Plan, at least one Todo Work,",
    "exactly one Todo Verify, a complete acyclic Work dependency graph, and Verify dependencies on every Work.",
    "Do not modify code. Do not return prose. Return only the requested PlanHandoff object.",
    `Set schema_version=1, runtime_generation=${request.runtime_generation}, correlation_id=${request.correlation_id}, role=plan.`,
  ].join("\n");
}

export class PlanPerformer {
  constructor(private readonly sessions: PlanSessionFactory) {}

  async executePlan(request: PlanRequest): Promise<PlanHandoff> {
    const session = await this.sessions.start(request);
    try {
      const result = await session.turn(planPrompt(request), PLAN_HANDOFF_SCHEMA);
      if (result.status !== "completed") throw new Error("plan_turn_not_completed");
      const handoff = parseStageHandoff(result.output);
      if (
        handoff.role !== "plan"
        || handoff.root_id !== request.root_id
        || handoff.runtime_generation !== request.runtime_generation
        || handoff.correlation_id !== request.correlation_id
        || handoff.cycle_issue_id !== request.cycle_issue_id
      ) throw new Error("plan_handoff_identity_mismatch");
      return handoff;
    } finally {
      await session.close();
    }
  }
}

export interface CodexPlanSessionOptions {
  readonly executable: string;
  readonly performerHome: string;
  readonly cwd: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly spawner?: CodexSpawner;
}

export class CodexPlanSessionFactory implements PlanSessionFactory {
  constructor(private readonly options: CodexPlanSessionOptions) {}

  async start(request: PlanRequest): Promise<PlanSession> {
    const process = await CodexProcess.start({
      executable: this.options.executable,
      codexHome: this.options.performerHome,
      rootId: request.root_id,
      runtimeGeneration: request.runtime_generation,
      startupTimeoutMs: this.options.startupTimeoutMs,
      requestTimeoutMs: this.options.requestTimeoutMs,
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
    }, this.options.spawner);
    let thread: CodexThread;
    try {
      thread = await CodexThread.create(process, {
        cwd: this.options.cwd,
        tools: [],
        correlationId: request.correlation_id,
        access: { kind: "read_only" },
      });
    } catch (error) {
      await process.shutdown();
      throw error;
    }
    return {
      turn: async (input, outputSchema) => {
        const result = await thread.turn(input, request.correlation_id, this.options.turnTimeoutMs, { ...outputSchema });
        return { status: result.status, ...(result.output === undefined ? {} : { output: result.output }) };
      },
      close: async () => {
        thread.close();
        await process.shutdown();
      },
    };
  }
}
