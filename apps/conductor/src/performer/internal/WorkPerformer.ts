import path from "node:path";
import { realpath } from "node:fs/promises";

import type { CodexSpawner } from "../../codex-app-server/internal/CodexProcess.js";
import { CodexProcess } from "../../codex-app-server/internal/CodexProcess.js";
import { CodexThread } from "../../codex-app-server/internal/CodexThread.js";
import type { CorrelationId, RootIssueId, ThreadId } from "../../contracts/identity.js";
import type { WorkHandoff, WorkRequest } from "../../contracts/stage-interaction.js";
import { parseStageHandoff } from "../../contracts/stage-interaction.js";

export interface WorkTurnResult {
  readonly status: "completed" | "interrupted" | "failed";
  readonly output?: unknown;
}

export interface WorkSession {
  readonly threadId: ThreadId | string;
  turn(
    input: string,
    correlationId: CorrelationId,
    outputSchema: Readonly<Record<string, unknown>>,
  ): Promise<WorkTurnResult>;
  close(): Promise<void>;
}

export interface WorkSessionFactory {
  start(request: WorkRequest): Promise<WorkSession>;
}

const WORK_HANDOFF_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    schema_version: { const: 1 },
    root_id: { type: "string" },
    runtime_generation: { type: "integer", minimum: 1 },
    correlation_id: { type: "string" },
    cycle_issue_id: { type: "string" },
    role: { const: "work" },
    work_issue_id: { type: "string" },
    outcome: { enum: ["completed", "failed", "canceled"] },
    workspace_changed: { type: "boolean" },
  },
  required: [
    "schema_version", "root_id", "runtime_generation", "correlation_id", "cycle_issue_id",
    "role", "work_issue_id", "outcome", "workspace_changed",
  ],
  additionalProperties: false,
} as const);

function cycleKey(rootId: string, cycleId: string): string {
  return JSON.stringify([rootId, cycleId]);
}

function workPrompt(request: WorkRequest): string {
  return [
    "You are the isolated Symphony Work role.",
    `For Root ${request.root_id}, Cycle ${request.cycle_issue_id}, execute Work ${request.work_issue_id}.`,
    "Edit only the current Root worktree and run focused checks for this Work Item.",
    `Use the installed Linear skill to update and read back only Work Issue ${request.work_issue_id}.`,
    "You must not modify the Work DAG, commit, push, or create a PR.",
    "Do not access or expose secrets. Return no prose; return only the requested WorkHandoff object.",
    `Set schema_version=1, root_id=${request.root_id}, runtime_generation=${request.runtime_generation},`,
    `correlation_id=${request.correlation_id}, cycle_issue_id=${request.cycle_issue_id}, role=work, work_issue_id=${request.work_issue_id}.`,
  ].join("\n");
}

interface CycleSession {
  readonly generation: number;
  readonly session: Promise<WorkSession>;
  readonly completedWork: Set<string>;
  active: boolean;
  closing?: Promise<void>;
}

export class WorkPerformer {
  readonly #cycles = new Map<string, CycleSession>();
  readonly #closedCycles = new Set<string>();

  constructor(private readonly sessions: WorkSessionFactory) {}

  async executeWork(request: WorkRequest): Promise<WorkHandoff> {
    const key = cycleKey(request.root_id, request.cycle_issue_id);
    if (this.#closedCycles.has(key)) throw new Error("work_cycle_closed");

    let cycle = this.#cycles.get(key);
    if (!cycle) {
      cycle = {
        generation: request.runtime_generation,
        session: this.sessions.start(request),
        completedWork: new Set(),
        active: false,
      };
      this.#cycles.set(key, cycle);
    }
    if (cycle.generation !== request.runtime_generation) {
      await this.#fence(key, cycle);
      throw new Error("work_cycle_generation_mismatch");
    }
    if (cycle.active) throw new Error("work_turn_already_active");
    if (cycle.completedWork.has(request.work_issue_id)) {
      await this.#fence(key, cycle);
      throw new Error("work_item_already_executed");
    }

    cycle.active = true;
    try {
      const session = await cycle.session;
      const result = await session.turn(workPrompt(request), request.correlation_id, WORK_HANDOFF_SCHEMA);
      if (result.status !== "completed") throw new Error("work_turn_not_completed");
      const handoff = parseStageHandoff(result.output);
      if (
        handoff.role !== "work"
        || handoff.root_id !== request.root_id
        || handoff.runtime_generation !== request.runtime_generation
        || handoff.correlation_id !== request.correlation_id
        || handoff.cycle_issue_id !== request.cycle_issue_id
        || handoff.work_issue_id !== request.work_issue_id
      ) throw new Error("work_handoff_identity_mismatch");
      cycle.completedWork.add(request.work_issue_id);
      if (handoff.outcome !== "completed") await this.#fence(key, cycle);
      return handoff;
    } catch (error) {
      await this.#fence(key, cycle);
      throw error;
    } finally {
      cycle.active = false;
    }
  }

  async closeCycle(rootId: RootIssueId, cycleId: WorkRequest["cycle_issue_id"]): Promise<void> {
    const key = cycleKey(rootId, cycleId);
    this.#closedCycles.add(key);
    const cycle = this.#cycles.get(key);
    if (!cycle) return;
    await this.#fence(key, cycle);
  }

  async #fence(key: string, cycle: CycleSession): Promise<void> {
    this.#cycles.delete(key);
    this.#closedCycles.add(key);
    cycle.closing ??= cycle.session.then((session) => session.close());
    await cycle.closing;
  }
}

export interface CodexWorkSessionOptions {
  readonly executable: string;
  readonly performerHome: string;
  readonly worktreePath: (rootId: RootIssueId) => Promise<string>;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly networkAccess: boolean;
  readonly spawner?: CodexSpawner;
}

export class CodexWorkSessionFactory implements WorkSessionFactory {
  constructor(private readonly options: CodexWorkSessionOptions) {}

  async start(request: WorkRequest): Promise<WorkSession> {
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
    }, this.options.spawner);
    let thread: CodexThread;
    try {
      thread = await CodexThread.create(process, {
        cwd: worktreePath,
        tools: [],
        correlationId: request.correlation_id,
        access: {
          kind: "workspace_write",
          writableRoot: worktreePath,
          networkAccess: this.options.networkAccess,
        },
      });
    } catch (error) {
      await process.shutdown();
      throw error;
    }
    let closed = false;
    return {
      threadId: thread.threadId,
      turn: async (input, correlationId, outputSchema) => {
        const result = await thread.turn(input, correlationId, this.options.turnTimeoutMs, { ...outputSchema });
        return { status: result.status, ...(result.output === undefined ? {} : { output: result.output }) };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        thread.close();
        await process.shutdown();
      },
    };
  }
}
