import { createHash } from "node:crypto";

import {
  parseCorrelationId,
  parseCycleIssueId,
  parseRootIssueId,
  parseRuntimeGeneration,
  parseTaskLabelId,
  parseTaskStateId,
  type CorrelationId,
  type CycleIssueId,
  type RootIssueId,
  type RuntimeGeneration,
  type TaskLabelId,
  type TaskStateId,
} from "../../contracts/identity.js";
import type {
  CycleSealDigest,
  ExecutionGraphSealDigest,
} from "../../contracts/cycle.js";
import { asRecord, assertExactKeys } from "../../contracts/validation.js";
import type { TaskMcpCall } from "../mcp/TaskMcpSchemas.js";

export const PERFORMER_TASK_MANAGE_CAPABILITIES = Object.freeze([] as const);

export interface TaskWorkflowIdentities {
  readonly labels: {
    readonly root: TaskLabelId;
    readonly cycle: TaskLabelId;
    readonly plan: TaskLabelId;
    readonly work: TaskLabelId;
    readonly verify: TaskLabelId;
  };
  readonly cycle_states: {
    readonly draft: TaskStateId;
    readonly in_progress: TaskStateId;
    readonly awaiting_acceptance: TaskStateId;
    readonly succeeded: TaskStateId;
    readonly rejected: TaskStateId;
    readonly failed: TaskStateId;
    readonly canceled: TaskStateId;
  };
  readonly stage_states: {
    readonly todo: TaskStateId;
    readonly in_progress: TaskStateId;
    readonly done: TaskStateId;
    readonly failed: TaskStateId;
    readonly canceled: TaskStateId;
  };
}

function parseIdentityRecord<const K extends readonly string[], T extends string>(
  value: unknown,
  keys: K,
  parser: (entry: unknown) => T,
): { readonly [P in K[number]]: T } {
  const record = asRecord(value);
  assertExactKeys(record, keys);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, parser(record[key])])) as {
    readonly [P in K[number]]: T;
  });
}

function assertDistinct(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new Error(code);
}

export function parseTaskWorkflowIdentities(value: unknown): TaskWorkflowIdentities {
  const record = asRecord(value);
  assertExactKeys(record, ["labels", "cycle_states", "stage_states"]);
  const labels = parseIdentityRecord(
    record.labels,
    ["root", "cycle", "plan", "work", "verify"] as const,
    parseTaskLabelId,
  );
  const cycleStates = parseIdentityRecord(
    record.cycle_states,
    ["draft", "in_progress", "awaiting_acceptance", "succeeded", "rejected", "failed", "canceled"] as const,
    parseTaskStateId,
  );
  const stageStates = parseIdentityRecord(
    record.stage_states,
    ["todo", "in_progress", "done", "failed", "canceled"] as const,
    parseTaskStateId,
  );
  assertDistinct(Object.values(labels), "duplicate_task_kind_identity");
  assertDistinct(Object.values(cycleStates), "duplicate_cycle_state_identity");
  assertDistinct(Object.values(stageStates), "duplicate_stage_state_identity");
  return Object.freeze({ labels, cycle_states: cycleStates, stage_states: stageStates });
}

declare const taskManageCallerCapabilityBrand: unique symbol;

export interface TaskManageCallerCapability {
  readonly caller: "root" | "cycle_machine" | "family_guard";
  readonly root_id: RootIssueId;
  readonly cycle_id: CycleIssueId | null;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly cycle_seal_digest: CycleSealDigest | null;
  readonly graph_seal_digest: ExecutionGraphSealDigest | null;
  readonly call_digest: string;
  readonly [taskManageCallerCapabilityBrand]: true;
}

export interface IssueTaskManageCallerInput {
  readonly caller: TaskManageCallerCapability["caller"];
  readonly root_id: RootIssueId;
  readonly cycle_id: CycleIssueId | null;
  readonly runtime_generation: RuntimeGeneration;
  readonly correlation_id: CorrelationId;
  readonly cycle_seal_digest: CycleSealDigest | null;
  readonly graph_seal_digest: ExecutionGraphSealDigest | null;
}

export interface TaskManageCallerIssuer {
  issue(input: IssueTaskManageCallerInput, call: TaskMcpCall): TaskManageCallerCapability;
}

export interface TaskManageCallerVerifier {
  assert(capability: TaskManageCallerCapability, call: TaskMcpCall): void;
}

export interface TaskManageCallerAuthority {
  readonly issuer: TaskManageCallerIssuer;
  readonly verifier: TaskManageCallerVerifier;
}

function callDigest(call: TaskMcpCall): string {
  return createHash("sha256").update(JSON.stringify(call), "utf8").digest("hex");
}

function parseSealDigest<T extends CycleSealDigest | ExecutionGraphSealDigest>(
  value: T | null,
): T | null {
  if (value !== null && (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))) {
    throw new Error("invalid_task_caller_scope");
  }
  return value;
}

export function createTaskManageCallerAuthority(): TaskManageCallerAuthority {
  const issuedCapabilities = new WeakSet<object>();
  const issuer: TaskManageCallerIssuer = Object.freeze({
    issue(input: IssueTaskManageCallerInput, call: TaskMcpCall): TaskManageCallerCapability {
      if (input.caller !== "root" && input.caller !== "cycle_machine" && input.caller !== "family_guard") {
        throw new Error("invalid_task_caller_scope");
      }
      const rootId = parseRootIssueId(input.root_id);
      const cycleId = input.cycle_id === null ? null : parseCycleIssueId(input.cycle_id);
      const cycleSealDigest = parseSealDigest(input.cycle_seal_digest);
      const graphSealDigest = parseSealDigest(input.graph_seal_digest);
      const hasCycleScope = cycleId !== null;
      const hasSealedScope = cycleSealDigest !== null && graphSealDigest !== null;
      if (
        (input.caller === "cycle_machine" && !hasCycleScope)
        || (input.caller === "family_guard" && hasCycleScope)
        || hasCycleScope !== hasSealedScope
        || (cycleSealDigest === null) !== (graphSealDigest === null)
      ) throw new Error("invalid_task_caller_scope");
      const capability = Object.freeze({
        caller: input.caller,
        root_id: rootId,
        cycle_id: cycleId,
        runtime_generation: parseRuntimeGeneration(input.runtime_generation),
        correlation_id: parseCorrelationId(input.correlation_id),
        cycle_seal_digest: cycleSealDigest,
        graph_seal_digest: graphSealDigest,
        call_digest: callDigest(call),
      }) as TaskManageCallerCapability;
      issuedCapabilities.add(capability);
      return capability;
    },
  });
  const verifier: TaskManageCallerVerifier = Object.freeze({
    assert(capability: TaskManageCallerCapability, call: TaskMcpCall): void {
      if (
        typeof capability !== "object"
        || capability === null
        || !issuedCapabilities.delete(capability)
        || capability.call_digest !== callDigest(call)
      ) throw new Error("invalid_task_caller_capability");
      if (
        capability.root_id !== call.root_id
        || capability.runtime_generation !== call.runtime_generation
        || capability.correlation_id !== call.correlation_id
      ) throw new Error("task_caller_target_mismatch");
    },
  });
  return Object.freeze({ issuer, verifier });
}
